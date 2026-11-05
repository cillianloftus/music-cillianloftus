/**
 * An artist's short bio from Wikipedia (the page's lead summary, with a link
 * back, as its licence asks), and what they do and play from Wikidata
 * (occupations, P106; instruments, P1303). Reached through the Wikidata id
 * MusicBrainz gives. Fill only; nothing edited by hand is touched.
 */

import { env } from 'cloudflare:workers';

const USER_AGENT = 'music-cillianloftus/0.1 ( https://music.cillianloftus.com )';
const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };

interface Entity {
  sitelinks?: { enwiki?: { title: string } };
  claims?: Record<string, { mainsnak: { datavalue?: { value: { id?: string } } } }[]>;
}

export interface WikiAbout {
  bio: string | null;
  bioUrl: string | null;
  occupations: string[];
  instruments: string[];
}

const ids = (entity: Entity, property: string) =>
  (entity.claims?.[property] ?? []).map((c) => c.mainsnak.datavalue?.value.id).filter((x): x is string => Boolean(x));

export async function wikiAbout(wikidataId: string, fetcher: typeof fetch = fetch): Promise<WikiAbout> {
  const about: WikiAbout = { bio: null, bioUrl: null, occupations: [], instruments: [] };
  const res = await fetcher(`https://www.wikidata.org/wiki/Special:EntityData/${wikidataId}.json`, { headers });
  if (!res.ok) return about;
  const entity = ((await res.json()) as { entities: Record<string, Entity> }).entities[wikidataId];
  if (!entity) return about;

  const occupationIds = ids(entity, 'P106').slice(0, 8);
  const instrumentIds = ids(entity, 'P1303').slice(0, 10);
  const wanted = [...occupationIds, ...instrumentIds];
  if (wanted.length) {
    const labels = await fetcher(
      `https://www.wikidata.org/w/api.php?${new URLSearchParams({ action: 'wbgetentities', ids: wanted.join('|'), props: 'labels', languages: 'en', format: 'json' })}`,
      { headers },
    );
    if (labels.ok) {
      const found = ((await labels.json()) as { entities: Record<string, { labels?: { en?: { value: string } } }> }).entities;
      const label = (id: string) => found[id]?.labels?.en?.value ?? null;
      about.occupations = occupationIds.map(label).filter((x): x is string => Boolean(x));
      about.instruments = instrumentIds.map(label).filter((x): x is string => Boolean(x));
    }
  }

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
    env.DB.prepare(
      `INSERT INTO lookup_log (source, entity_id, found) VALUES ('wikipedia', ?, ?)
       ON CONFLICT (source, entity_id) DO UPDATE SET found = excluded.found, looked_at = excluded.looked_at`,
    ).bind(artistId, about.bio ? 1 : 0),
  ]);
  return true;
}
