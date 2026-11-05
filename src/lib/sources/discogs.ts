/**
 * Discogs (api.discogs.com): the label, catalogue number, country and
 * format of a release, strongest for physical editions MusicBrainz is thin
 * on. Found by barcode when there is one, otherwise by artist and title,
 * accepted only when both match. Fill only: a field already set, or edited
 * by hand, is left alone. Needs a personal access token.
 */

import { env } from 'cloudflare:workers';
import { credentials } from '../connections';
import { normaliseName, normaliseTitle } from '../text';

type Fetcher = typeof fetch;
const API = 'https://api.discogs.com';

async function get<T>(token: string, path: string, fetcher: Fetcher): Promise<T> {
  const res = await fetcher(`${API}${path}`, {
    headers: { accept: 'application/json', authorization: `Discogs token=${token}`, 'user-agent': 'music.cillianloftus.com/1.0' },
  });
  if (res.status === 401) throw new Error('Discogs did not accept the token.');
  if (!res.ok) throw new Error(`Discogs answered ${res.status}.`);
  return (await res.json()) as T;
}

/** The Discogs username a token belongs to. */
export async function identity(token: string, fetcher: Fetcher = fetch): Promise<string> {
  return (await get<{ username: string }>(token, '/oauth/identity', fetcher)).username;
}

export interface DiscogsHit {
  id: number;
  /** "Artist - Title" */
  title: string;
  label?: string[];
  catno?: string;
  country?: string;
  format?: string[];
  year?: string;
  uri?: string;
}

export async function findRelease(
  token: string,
  query: { artist: string; title: string; barcode: string | null },
  fetcher: Fetcher = fetch,
): Promise<DiscogsHit | null> {
  const matches = (hit: DiscogsHit) => {
    const [artist, ...rest] = hit.title.split(' - ');
    // Discogs tells same-named artists apart as "Name (2)": drop that before comparing.
    return normaliseName((artist ?? '').replace(/\s*\(\d+\)$/, '')) === normaliseName(query.artist) && normaliseTitle(rest.join(' - ')) === normaliseTitle(query.title);
  };
  if (query.barcode) {
    const byCode = await get<{ results: DiscogsHit[] }>(token, `/database/search?type=release&barcode=${encodeURIComponent(query.barcode)}`, fetcher);
    // A barcode is specific enough on its own, but still sanity-check the title.
    const hit = byCode.results.find((h) => normaliseTitle(h.title.split(' - ').slice(1).join(' - ')) === normaliseTitle(query.title)) ?? null;
    if (hit) return hit;
  }
  const params = new URLSearchParams({ type: 'release', artist: query.artist, release_title: query.title, per_page: '10' });
  const search = await get<{ results: DiscogsHit[] }>(token, `/database/search?${params}`, fetcher);
  return search.results.find(matches) ?? null;
}

/** "Vinyl, LP, Album" from Discogs' format list, trimmed of repeats. */
export const formatWords = (format: string[] | undefined) => (format ? [...new Set(format)].slice(0, 3).join(', ') : null);

/** Fills an album's standard edition from Discogs. Returns false without a token. */
export async function fillFromDiscogs(albumId: string, fetcher: Fetcher = fetch): Promise<boolean> {
  const creds = await credentials('discogs');
  if (!creds) return false;
  const row = await env.DB.prepare(
    `SELECT g.title, r.id AS release_id, r.label, r.barcode, r.country, r.format,
            (SELECT a.name FROM artist_credit c JOIN artist a ON a.id = c.artist_id
             WHERE c.entity_type = 'release_group' AND c.entity_id = g.id AND c.role = 'primary' ORDER BY c.position LIMIT 1) AS artist
     FROM release_group g
     JOIN v_release_group_canonical v ON v.release_group_id = g.id
     JOIN release r ON r.id = v.release_id
     WHERE g.id = ?`,
  )
    .bind(albumId)
    .first<{ title: string; release_id: string; label: string | null; barcode: string | null; country: string | null; format: string | null; artist: string | null }>();
  if (!row?.artist) return true;

  const hit = await findRelease(creds.token!, { artist: row.artist, title: row.title, barcode: row.barcode }, fetcher);
  const untouched = (field: string) =>
    `NOT EXISTS (SELECT 1 FROM field_override o WHERE o.entity_type = 'release' AND o.entity_id = ?1 AND o.field = '${field}')`;
  const statements: D1PreparedStatement[] = [];
  if (hit) {
    const label = hit.label?.[0];
    if (!row.label && label) statements.push(env.DB.prepare(`UPDATE release SET label = ?2 WHERE id = ?1 AND label IS NULL AND ${untouched('label')}`).bind(row.release_id, label));
    if (!row.country && hit.country) statements.push(env.DB.prepare(`UPDATE release SET country = ?2 WHERE id = ?1 AND country IS NULL AND ${untouched('country')}`).bind(row.release_id, hit.country));
    const format = formatWords(hit.format);
    if (!row.format && format) statements.push(env.DB.prepare(`UPDATE release SET format = ?2 WHERE id = ?1 AND format IS NULL AND ${untouched('format')}`).bind(row.release_id, format));
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO lookup_log (source, entity_id, found) VALUES ('discogs', ?, ?)
       ON CONFLICT (source, entity_id) DO UPDATE SET found = excluded.found, looked_at = excluded.looked_at`,
    ).bind(albumId, hit ? 1 : 0),
  );
  await env.DB.batch(statements);
  return true;
}

/** Albums not asked about in a month; Discogs allows 60 requests a minute. */
export async function fillAlbumsFromDiscogs({ budgetMs, limit = 20 }: { budgetMs: number; limit?: number }): Promise<number> {
  if (!(await credentials('discogs'))) return 0;
  const deadline = Date.now() + budgetMs;
  const { results } = await env.DB.prepare(
    `SELECT g.id FROM release_group g
     WHERE NOT EXISTS (SELECT 1 FROM lookup_log l WHERE l.source = 'discogs' AND l.entity_id = g.id AND l.looked_at > datetime('now', '-30 days'))
     ORDER BY g.created_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string }>();
  let done = 0;
  for (const { id } of results) {
    if (Date.now() > deadline) break;
    await fillFromDiscogs(id).catch((error) => console.warn('Discogs fill failed', id, error));
    done += 1;
    await new Promise((r) => setTimeout(r, 1100));
  }
  return done;
}
