/**
 * An artist's short bio from Wikipedia (the page's lead summary, with a link
 * back, as its licence asks), and what they do and play from Wikidata
 * (occupations, P106; instruments, P1303). Reached through the Wikidata id
 * MusicBrainz gives. Fill only; nothing edited by hand is touched.
 */

import { env } from 'cloudflare:workers';

const USER_AGENT = 'music-cillianloftus/0.1 ( https://music.cillianloftus.com )';
const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

interface Snak {
  datavalue?: { value: { id?: string; time?: string; text?: string; language?: string } };
}

interface Claim {
  mainsnak: Snak;
  rank?: 'preferred' | 'normal' | 'deprecated';
  qualifiers?: Record<string, Snak[]>;
}

interface Entity {
  sitelinks?: { enwiki?: { title: string } };
  claims?: Record<string, Claim[]>;
}

/** One statement about an artist (migration 0056). */
export interface WikiFact {
  property: 'award' | 'nomination' | 'label' | 'influenced_by' | 'birthplace' | 'deathplace' | 'educated_at' | 'citizenship' | 'nickname';
  /** The item it names (Q…), or a nickname's text. */
  valueId: string;
  label: string;
  year: number | null;
}

export interface WikiAbout {
  bio: string | null;
  bioUrl: string | null;
  occupations: string[];
  instruments: string[];
  facts: WikiFact[];
}

const ids = (entity: Entity, property: string) =>
  (entity.claims?.[property] ?? []).map((c) => c.mainsnak.datavalue?.value.id).filter((x): x is string => Boolean(x));

/** Wikidata properties kept as facts, and how many of each at most. */
const FACT_PROPERTIES: [string, WikiFact['property'], number][] = [
  ['P166', 'award', 40],
  ['P1411', 'nomination', 60],
  ['P264', 'label', 12],
  ['P737', 'influenced_by', 30],
  ['P19', 'birthplace', 1],
  ['P20', 'deathplace', 1],
  ['P69', 'educated_at', 6],
  ['P27', 'citizenship', 4],
];

/** The year a statement held: its point in time (P585), else its start (P580). */
function yearOfClaim(claim: Claim): number | null {
  const time = (claim.qualifiers?.P585 ?? claim.qualifiers?.P580 ?? [])[0]?.datavalue?.value.time;
  const year = time ? /^[+-](\d{4})/.exec(time)?.[1] : null;
  return year ? Number(year) : null;
}

/** The items each fact names, without labels yet; nicknames complete. Pure. */
export function factClaims(entity: Entity): { facts: Omit<WikiFact, 'label'>[]; nicknames: WikiFact[] } {
  const facts: Omit<WikiFact, 'label'>[] = [];
  for (const [pid, property, max] of FACT_PROPERTIES) {
    const claims = (entity.claims?.[pid] ?? []).filter((c) => c.rank !== 'deprecated' && c.mainsnak.datavalue?.value.id);
    const seen = new Set<string>();
    for (const claim of claims) {
      const valueId = claim.mainsnak.datavalue!.value.id!;
      if (seen.has(valueId) || seen.size >= max) continue;
      seen.add(valueId);
      facts.push({ property, valueId, year: yearOfClaim(claim) });
    }
  }
  const nicknames = (entity.claims?.P1449 ?? [])
    .map((c) => c.mainsnak.datavalue?.value)
    .filter((v): v is { text: string; language?: string } => Boolean(v?.text) && (!v?.language || v.language === 'en'))
    .slice(0, 6)
    .map((v) => ({ property: 'nickname' as const, valueId: v.text, label: v.text, year: null }));
  return { facts, nicknames };
}

/** English labels for Wikidata items, fifty to a request. */
async function labelsFor(itemIds: string[], fetcher: typeof fetch): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  for (let i = 0; i < itemIds.length; i += 50) {
    const chunk = itemIds.slice(i, i + 50);
    const res = await fetcher(
      `https://www.wikidata.org/w/api.php?${new URLSearchParams({ action: 'wbgetentities', ids: chunk.join('|'), props: 'labels', languages: 'en', format: 'json' })}`,
      { headers },
    );
    if (!res.ok) continue;
    const found = ((await res.json()) as { entities: Record<string, { labels?: { en?: { value: string } } }> }).entities;
    for (const id of chunk) {
      const label = found[id]?.labels?.en?.value;
      if (label) labels.set(id, label);
    }
  }
  return labels;
}

export async function wikiAbout(wikidataId: string, fetcher: typeof fetch = fetch): Promise<WikiAbout> {
  const about: WikiAbout = { bio: null, bioUrl: null, occupations: [], instruments: [], facts: [] };
  const res = await fetcher(`https://www.wikidata.org/wiki/Special:EntityData/${wikidataId}.json`, { headers });
  if (!res.ok) return about;
  const entity = ((await res.json()) as { entities: Record<string, Entity> }).entities[wikidataId];
  if (!entity) return about;

  const occupationIds = ids(entity, 'P106').slice(0, 8);
  const instrumentIds = ids(entity, 'P1303').slice(0, 10);
  const { facts, nicknames } = factClaims(entity);
  const wanted = [...new Set([...occupationIds, ...instrumentIds, ...facts.map((f) => f.valueId)])];
  if (wanted.length) {
    const labels = await labelsFor(wanted, fetcher);
    const label = (id: string) => labels.get(id) ?? null;
    about.occupations = occupationIds.map(label).filter((x): x is string => Boolean(x));
    about.instruments = instrumentIds.map(label).filter((x): x is string => Boolean(x));
    // A statement whose item has no English name is left out rather than shown as "Q12345".
    about.facts = facts.flatMap((f) => (labels.has(f.valueId) ? [{ ...f, label: labels.get(f.valueId)! }] : []));
  }
  about.facts.push(...nicknames);

  const title = entity.sitelinks?.enwiki?.title;
  if (title) {
    const summary = await fetcher(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`, { headers });
    if (summary.ok) {
      const page = (await summary.json()) as { type?: string; extract?: string; content_urls?: { desktop?: { page?: string } } };
      if (page.type === 'standard' && page.extract) {
        about.bio = page.extract.length > 2000 ? `${page.extract.slice(0, 1990).replace(/\s+\S*$/, '')}…` : page.extract;
        const url = page.content_urls?.desktop?.page ?? null;
        about.bioUrl = url && /^https:\/\/[a-z-]+\.wikipedia\.org\//.test(url) ? url : null;
      }
    }
  }
  return about;
}

/** Looks an artist up on Wikidata and Wikipedia and fills what is empty. */
export async function fillArtistFromWiki(artistId: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT wikidata_id FROM artist WHERE id = ?`).bind(artistId).first<{ wikidata_id: string | null }>();
  if (!row?.wikidata_id) return false;
  const about = await wikiAbout(row.wikidata_id, fetcher);
  const untouched = (field: string) =>
    `NOT EXISTS (SELECT 1 FROM field_override o WHERE o.entity_type = 'artist' AND o.entity_id = ?1 AND o.field = '${field}')`;
  await env.DB.batch([
    env.DB.prepare(`UPDATE artist SET bio = ?2, bio_url = ?3 WHERE id = ?1 AND bio IS NULL AND ?2 IS NOT NULL AND ${untouched('bio')}`).bind(
      artistId,
      about.bio,
      about.bioUrl,
    ),
    env.DB.prepare(`UPDATE artist SET occupations = ?2 WHERE id = ?1 AND occupations IS NULL AND ?3 > 0`).bind(
      artistId,
      JSON.stringify(about.occupations),
      about.occupations.length,
    ),
    env.DB.prepare(`UPDATE artist SET instruments = ?2 WHERE id = ?1 AND instruments IS NULL AND ?3 > 0`).bind(
      artistId,
      JSON.stringify(about.instruments),
      about.instruments.length,
    ),
    // Facts as Wikidata has them now: gone ones taken away, new ones added.
    env.DB.prepare(
      `DELETE FROM artist_fact WHERE artist_id = ?1
         AND property || ':' || value_id NOT IN (SELECT (j.value ->> '$.property') || ':' || (j.value ->> '$.valueId') FROM json_each(?2) j)`,
    ).bind(artistId, JSON.stringify(about.facts)),
    env.DB.prepare(
      `INSERT INTO artist_fact (artist_id, property, value_id, label, year)
       SELECT ?1, j.value ->> '$.property', j.value ->> '$.valueId', j.value ->> '$.label', j.value ->> '$.year' FROM json_each(?2) j WHERE true
       ON CONFLICT DO UPDATE SET label = excluded.label, year = excluded.year`,
    ).bind(artistId, JSON.stringify(about.facts)),
    env.DB.prepare(
      `INSERT INTO lookup_log (source, entity_id, found) VALUES ('wikipedia', ?, ?)
       ON CONFLICT (source, entity_id) DO UPDATE SET found = excluded.found, looked_at = excluded.looked_at`,
    ).bind(artistId, about.bio ? 1 : 0),
    env.DB.prepare(
      `INSERT INTO lookup_log (source, entity_id, found) VALUES ('wikidata', ?, ?)
       ON CONFLICT (source, entity_id) DO UPDATE SET found = excluded.found, looked_at = excluded.looked_at`,
    ).bind(artistId, about.facts.length > 0 ? 1 : 0),
  ]);
  return true;
}

/**
 * Artists with a Wikidata id whose facts have not been read (never, or not
 * in three months), until the budget runs out: one Wikidata entity and a
 * label request or two each.
 */
export async function fillArtistsFromWiki({ budgetMs, limit = 40 }: { budgetMs: number; limit?: number }): Promise<{ artists: number; left: number }> {
  const deadline = Date.now() + budgetMs;
  const waiting = `FROM artist a WHERE a.wikidata_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM lookup_log l WHERE l.source = 'wikidata' AND l.entity_id = a.id AND l.looked_at > datetime('now', '-90 days'))`;
  const { results } = await env.DB.prepare(`SELECT a.id ${waiting} LIMIT ?`).bind(limit).all<{ id: string }>();
  let artists = 0;
  for (const { id } of results) {
    if (Date.now() > deadline) break;
    await fillArtistFromWiki(id).catch((error) => console.warn('Wikidata lookup failed', id, error));
    artists += 1;
  }
  const left = (await env.DB.prepare(`SELECT count(*) AS n ${waiting}`).first<{ n: number }>())?.n ?? 0;
  return { artists, left };
}
