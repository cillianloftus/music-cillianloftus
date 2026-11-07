/**
 * Refreshes src/data/mb-genre-relations.json: for every genre MusicBrainz
 * knows, what it is a subgenre of, a fusion of, and influenced by. The
 * genre editor offers these as suggestions (src/lib/genre-suggest.ts).
 *
 * MusicBrainz's API lists genres but not their relationships, so each
 * genre's page is read, starting no more than one a second as MusicBrainz
 * asks. About 40 minutes for all of them; progress is kept, so a stopped
 * run carries on where it left off.
 *
 *   node scripts/mb-genre-relations.ts [genres-first.txt]
 */

import dns from 'node:dns';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

dns.setDefaultResultOrder('ipv4first');

const UA = 'music-cillianloftus/0.1 ( https://music.cillianloftus.com )';
const OUT = 'src/data/mb-genre-relations.json';
const PROGRESS = 'scripts/.mb-genre-relations.progress.json';
const GAP_MS = 1100;

type Relations = { sub?: string[]; fusion?: string[]; infl?: string[] };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(url: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
      const body = await response.text();
      // MusicBrainz answers "busy" with a 503 or a JSON error.
      if (response.ok && !body.startsWith('{"error"')) return body;
      if (response.status === 404) return '';
    } catch {
      // Retried below.
    }
    if (attempt >= 6) throw new Error(`Gave up on ${url}`);
    await sleep(2000 * 2 ** attempt);
  }
}

async function allGenres(): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  for (let offset = 0; ; offset += 100) {
    const json = JSON.parse(await get(`https://musicbrainz.org/ws/2/genre/all?limit=100&offset=${offset}&fmt=json`)) as {
      'genre-count': number;
      genres: { id: string; name: string }[];
    };
    out.push(...json.genres);
    if (offset + 100 >= json['genre-count']) return out;
    await sleep(GAP_MS);
  }
}

const LABELS: Record<string, keyof Relations> = {
  'subgenre of:': 'sub',
  'fusion of:': 'fusion',
  'influenced by:': 'infl',
};

/** The genres named in each relationship row of a genre's page. */
export function parseGenrePage(html: string): Relations {
  const out: Relations = {};
  for (const row of html.matchAll(/<th>([^<]+)<\/th><td[^>]*>(.*?)<\/td>/g)) {
    const key = LABELS[row[1].trim()];
    if (!key) continue;
    const names = [...row[2].matchAll(/href="\/genre\/[0-9a-f-]+"><bdi>([^<]+)<\/bdi>/g)].map((m) => decode(m[1]).toLowerCase());
    if (names.length) out[key] = [...new Set(names)];
  }
  return out;
}

const decode = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function main() {
  const progress: Record<string, Relations> = existsSync(PROGRESS) ? JSON.parse(readFileSync(PROGRESS, 'utf8')) : {};
  const genres = await allGenres();
  console.log(`${genres.length} genres, ${Object.keys(progress).length} already read`);
  let n = 0;
  // Pages are slow to arrive, so a few are in flight at once; requests still
  // start no closer than GAP_MS apart, within MusicBrainz's one a second.
  const queue = genres.filter((g) => progress[g.name] === undefined);
  // Genres named in a file (one per line, say the library's) go first, and
  // then what each is a subgenre or fusion of, so suggestions for them are
  // complete long before the whole run is.
  const first = new Set(
    // Trimming each line takes care of Windows line ends.
    (process.argv[2] ? readFileSync(process.argv[2], 'utf8').split('\n') : []).map((n) => n.trim().toLowerCase()).filter(Boolean),
  );
  const bringForward = (names: string[]) => {
    for (const name of names) {
      const i = queue.findIndex((g) => g.name.toLowerCase() === name.toLowerCase());
      if (i > 0) queue.unshift(...queue.splice(i, 1));
    }
  };
  bringForward([...first]);
  let nextStart = Date.now();
  const worker = async () => {
    for (let genre = queue.shift(); genre; genre = queue.shift()) {
      const wait = nextStart - Date.now();
      nextStart = Math.max(Date.now(), nextStart) + GAP_MS;
      if (wait > 0) await sleep(wait);
      const found = parseGenrePage(await get(`https://musicbrainz.org/genre/${genre.id}`));
      progress[genre.name] = found;
      if (first.size) bringForward([...(found.sub ?? []), ...(found.fusion ?? [])]);
      if (++n % 25 === 0) {
        writeFileSync(PROGRESS, JSON.stringify(progress));
        console.log(`${Object.keys(progress).length} / ${genres.length}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  writeFileSync(PROGRESS, JSON.stringify(progress));

  const relations: Record<string, Relations> = {};
  for (const name of Object.keys(progress).sort()) {
    const r = progress[name];
    if (r.sub || r.fusion || r.infl) relations[name.toLowerCase()] = r;
  }
  writeFileSync(OUT, JSON.stringify({ source: 'musicbrainz.org', fetched: new Date().toISOString().slice(0, 10), relations }) + '\n');
  console.log(`Wrote ${OUT}: ${Object.keys(relations).length} genres with relationships`);
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('mb-genre-relations.ts')) {
  await main();
}
