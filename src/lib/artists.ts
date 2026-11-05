/**
 * Who an artist is: kind (person, group, duo...), born or formed, where
 * from, other names, members, pictures. From MusicBrainz, with pictures
 * from Wikimedia Commons (via Wikidata) and Spotify.
 *
 * Enrichment fills empty fields only and never touches a field set by hand
 * (field_override), the same rule as imports. Aliases mean a credit under
 * any of an artist's names finds the same artist: Benjamin Lasky is
 * Quadeca.
 */

import { fillArtistFromWiki } from './sources/wikipedia';
import { env } from 'cloudflare:workers';
import type { DatePrecision } from './dates';
import { getArtistDetails, type MbArtistDetails } from './musicbrainz/client';

export type ArtistKind = 'person' | 'group' | 'duo' | 'orchestra' | 'choir' | 'character' | 'other';

export const KIND_LABELS: Record<ArtistKind, string> = {
  person: 'Person',
  group: 'Group',
  duo: 'Duo',
  orchestra: 'Orchestra',
  choir: 'Choir',
  character: 'Character',
  other: 'Other',
};

/** How a kind's begin and end read: born and died, or formed and split. */
export function lifeWords(kind: ArtistKind | null): { begin: string; end: string } {
  return kind === 'person' || kind === 'character' ? { begin: 'Born', end: 'Died' } : { begin: 'Formed', end: 'Disbanded' };
}

const precisionOf = (date: string | null | undefined): { date: string | null; precision: DatePrecision } => {
  const d = date?.trim();
  if (!d) return { date: null, precision: 'unknown' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return { date: d, precision: 'day' };
  if (/^\d{4}-\d{2}$/.test(d)) return { date: d, precision: 'month' };
  if (/^\d{4}$/.test(d)) return { date: d, precision: 'year' };
  return { date: null, precision: 'unknown' };
};

export interface Enrichment {
  kind: ArtistKind | null;
  begin: { date: string | null; precision: DatePrecision };
  end: { date: string | null; precision: DatePrecision };
  area: string | null;
  wikidataId: string | null;
  spotifyId: string | null;
  aliases: { name: string; kind: 'legal' | 'search' | 'alias' | 'performance' }[];
  /** Official site and profiles. */
  links: { kind: string; url: string }[];
  /** MBIDs of this artist's members, and of the groups it is a member of. */
  members: string[];
  memberOf: string[];
}

/** Hosts worth a link on an artist's page, by kind. Streaming services and databases are left out. */
const LINK_HOSTS: [RegExp, string][] = [
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)(twitter|x)\.com$/, 'x'],
  [/(^|\.)youtube\.com$/, 'youtube'],
  [/(^|\.)tiktok\.com$/, 'tiktok'],
  [/(^|\.)bandcamp\.com$/, 'bandcamp'],
  [/(^|\.)soundcloud\.com$/, 'soundcloud'],
  [/(^|\.)facebook\.com$/, 'facebook'],
  [/(^|\.)genius\.com$/, 'genius'],
];

/** An artist's official site and social profiles, from MusicBrainz url relations. Pure. */
export function linksFrom(rels: { type: string; url: string }[]): { kind: string; url: string }[] {
  const out = new Map<string, { kind: string; url: string }>();
  for (const { type, url } of rels) {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    const kind = type === 'official homepage' ? 'website' : LINK_HOSTS.find(([re]) => re.test(host))?.[1];
    if (kind && !out.has(kind) && /^https?:\/\//.test(url)) out.set(kind, { kind, url: url.replace(/^http:/, 'https:') });
  }
  return [...out.values()];
}

/** Reads a MusicBrainz artist into what this catalogue keeps. Pure. */
export function readArtist(mb: MbArtistDetails): Enrichment {
  const relations = mb.relations ?? [];
  const memberRels = relations.filter((r) => r['target-type'] === 'artist' && r.type === 'member of band' && r.artist);
  // "member of band" from the member's side is forward; from the group's, backward.
  const members = [...new Set(memberRels.filter((r) => r.direction === 'backward').map((r) => r.artist!.id))];
  const memberOf = [...new Set(memberRels.filter((r) => r.direction === 'forward').map((r) => r.artist!.id))];

  const types: Record<string, ArtistKind> = {
    Person: 'person',
    Group: 'group',
    Orchestra: 'orchestra',
    Choir: 'choir',
    Character: 'character',
    Other: 'other',
  };
  let kind: ArtistKind | null = mb.type ? (types[mb.type] ?? 'other') : null;
  if (kind === 'group' && members.length === 2) kind = 'duo';

  const urls = relations.filter((r) => r['target-type'] === 'url' && r.url).map((r) => r.url!.resource);
  const wikidataId = urls.map((u) => /wikidata\.org\/wiki\/(Q\d+)/.exec(u)?.[1]).find(Boolean) ?? null;
  const spotifyId = urls.map((u) => /open\.spotify\.com\/artist\/([A-Za-z0-9]{22})/.exec(u)?.[1]).find(Boolean) ?? null;
  const links = linksFrom(relations.filter((r) => r['target-type'] === 'url' && r.url).map((r) => ({ type: r.type, url: r.url!.resource })));

  const aliasKinds: Record<string, Enrichment['aliases'][number]['kind']> = {
    'Legal name': 'legal',
    'Search hint': 'search',
    'Artist name': 'performance',
  };
  const seen = new Set([mb.name.toLowerCase()]);
  const aliases: Enrichment['aliases'] = [];
  for (const a of mb.aliases ?? []) {
    const name = a.name.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    aliases.push({ name, kind: (a.type && aliasKinds[a.type]) || 'alias' });
  }

  // A person's area is where they were born; a group's, where it formed.
  const area = mb['begin-area']?.name ?? mb.area?.name ?? null;

  return {
    kind,
    begin: precisionOf(mb['life-span']?.begin),
    end: precisionOf(mb['life-span']?.end),
    area,
    wikidataId,
    spotifyId,
    aliases,
    links,
    members,
    memberOf,
  };
}

/** Writes an enrichment: empty fields only, hand-set fields never. One transaction. */
export async function applyEnrichment(artistId: string, e: Enrichment): Promise<void> {
  const db = env.DB;
  const notOverridden = (field: string) =>
    `NOT EXISTS (SELECT 1 FROM field_override o WHERE o.entity_type = 'artist' AND o.entity_id = ?1 AND o.field = '${field}')`;
  const statements = [
    db.prepare(`UPDATE artist SET kind = ?2 WHERE id = ?1 AND kind IS NULL AND ?2 IS NOT NULL AND ${notOverridden('kind')}`).bind(artistId, e.kind),
    db.prepare(
      `UPDATE artist SET begin_date = ?2, begin_precision = ?3
       WHERE id = ?1 AND begin_date IS NULL AND ?2 IS NOT NULL AND ${notOverridden('begin_date')}`,
    ).bind(artistId, e.begin.date, e.begin.precision),
    db.prepare(
      `UPDATE artist SET end_date = ?2, end_precision = ?3
       WHERE id = ?1 AND end_date IS NULL AND ?2 IS NOT NULL AND ${notOverridden('end_date')}`,
    ).bind(artistId, e.end.date, e.end.precision),
    db.prepare(`UPDATE artist SET area = ?2 WHERE id = ?1 AND area IS NULL AND ?2 IS NOT NULL AND ${notOverridden('area')}`).bind(artistId, e.area),
    db.prepare(`UPDATE artist SET wikidata_id = ?2 WHERE id = ?1 AND wikidata_id IS NULL AND ?2 IS NOT NULL`).bind(artistId, e.wikidataId),
    db.prepare(
      `UPDATE artist SET spotify_id = ?2
       WHERE id = ?1 AND spotify_id IS NULL AND ?2 IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM artist o WHERE o.spotify_id = ?2)`,
    ).bind(artistId, e.spotifyId),
    db.prepare(
      `INSERT INTO artist_alias (artist_id, name, kind, source)
       SELECT ?1, j.value ->> '$.name', j.value ->> '$.kind', 'musicbrainz' FROM json_each(?2) j WHERE true
       ON CONFLICT DO NOTHING`,
    ).bind(artistId, JSON.stringify(e.aliases)),
    // Members and groups, where both are in the catalogue.
    db.prepare(
      `INSERT INTO artist_link (artist_id, other_id, kind, source)
       SELECT a.id, ?1, 'member_of', 'musicbrainz' FROM artist a WHERE a.mbid IN (SELECT value FROM json_each(?2)) AND a.id <> ?1
       ON CONFLICT DO NOTHING`,
    ).bind(artistId, JSON.stringify(e.members)),
    db.prepare(
      `INSERT INTO artist_link (artist_id, other_id, kind, source)
       SELECT ?1, a.id, 'member_of', 'musicbrainz' FROM artist a WHERE a.mbid IN (SELECT value FROM json_each(?2)) AND a.id <> ?1
       ON CONFLICT DO NOTHING`,
    ).bind(artistId, JSON.stringify(e.memberOf)),
    db.prepare(
      `INSERT INTO artist_url (artist_id, kind, url, source)
       SELECT ?1, j.value ->> '$.kind', j.value ->> '$.url', 'musicbrainz' FROM json_each(?2) j WHERE true
       ON CONFLICT DO NOTHING`,
    ).bind(artistId, JSON.stringify(e.links)),
    db.prepare(`UPDATE artist SET enriched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1`).bind(artistId),
  ];
  await db.batch(statements);
}

/** Looks one artist up on MusicBrainz and applies what it says. */
export async function enrichArtist(artistId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT mbid FROM artist WHERE id = ?`).bind(artistId).first<{ mbid: string | null }>();
  if (!row?.mbid) return false;
  await applyEnrichment(artistId, readArtist(await getArtistDetails(row.mbid)));
  // Their bio and what they do, now the Wikidata id is known. Best effort.
  await fillArtistFromWiki(artistId).catch((error) => console.warn('Wikipedia lookup failed', artistId, error));
  return true;
}

/**
 * Enriches artists never looked at (or not for 90 days), primary artists
 * first, within a time budget: MusicBrainz allows about one request a
 * second. Returns how many were done.
 */
export async function enrichArtists({ budgetMs, limit = 40 }: { budgetMs: number; limit?: number }): Promise<number> {
  const deadline = Date.now() + budgetMs;
  const { results } = await env.DB.prepare(
    `SELECT a.id FROM artist a
     WHERE a.mbid IS NOT NULL
       AND (a.enriched_at IS NULL OR a.enriched_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days'))
     ORDER BY EXISTS (SELECT 1 FROM artist_credit c WHERE c.artist_id = a.id AND c.role = 'primary') DESC,
              a.enriched_at IS NOT NULL, a.created_at
     LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string }>();
  let done = 0;
  for (const { id } of results) {
    if (Date.now() > deadline) break;
    try {
      if (await enrichArtist(id)) done++;
    } catch (error) {
      console.warn('Artist enrichment failed', id, error);
    }
  }
  return done;
}

export interface ArtistAbout {
  kind: ArtistKind | null;
  begin_date: string | null;
  begin_precision: DatePrecision;
  end_date: string | null;
  end_precision: DatePrecision;
  area: string | null;
  aliases: { name: string; kind: string }[];
  /** Groups this artist is in, and this group's members. */
  memberOf: { id: string; name: string }[];
  members: { id: string; name: string }[];
  sameAs: { id: string; name: string }[];
  /** The opening of their Wikipedia article, and the article. */
  bio: string | null;
  bio_url: string | null;
  /** What they do and play, from Wikidata ("rapper", "piano"). */
  occupations: string[];
  instruments: string[];
  /** Where they are on the web: official site and profiles. */
  urls: { kind: string; url: string }[];
  mbid: string | null;
  spotify_id: string | null;
  discogs_id: string | null;
}

export async function artistAbout(artistId: string): Promise<ArtistAbout> {
  const [row, aliases, links, urls] = await env.DB.batch([
    env.DB.prepare(
      `SELECT kind, begin_date, begin_precision, end_date, end_precision, area, bio, bio_url, occupations, instruments, mbid, spotify_id, discogs_id
       FROM artist WHERE id = ?`,
    ).bind(artistId),
    env.DB.prepare(
      `SELECT name, kind FROM artist_alias WHERE artist_id = ?
       ORDER BY CASE kind WHEN 'legal' THEN 0 WHEN 'performance' THEN 1 WHEN 'alias' THEN 2 ELSE 3 END, name`,
    ).bind(artistId),
    env.DB.prepare(
      `SELECT l.kind, 'out' AS dir, a.id, a.name FROM artist_link l JOIN artist a ON a.id = l.other_id WHERE l.artist_id = ?1
       UNION ALL
       SELECT l.kind, 'in' AS dir, a.id, a.name FROM artist_link l JOIN artist a ON a.id = l.artist_id WHERE l.other_id = ?1
       ORDER BY 4`,
    ).bind(artistId),
    env.DB.prepare(
      `SELECT kind, url FROM artist_url WHERE artist_id = ?
       ORDER BY CASE kind WHEN 'website' THEN 0 WHEN 'bandcamp' THEN 1 WHEN 'instagram' THEN 2 WHEN 'youtube' THEN 3 ELSE 4 END, kind`,
    ).bind(artistId),
  ]);
  const base = (row!.results[0] ?? {}) as Omit<ArtistAbout, 'aliases' | 'memberOf' | 'members' | 'sameAs' | 'occupations' | 'instruments' | 'urls'> & {
    occupations?: string | null;
    instruments?: string | null;
  };
  const list = (json: string | null | undefined): string[] => {
    try {
      const value = JSON.parse(json ?? '[]') as unknown;
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  };
  const linkRows = links!.results as { kind: string; dir: 'in' | 'out'; id: string; name: string }[];
  const pick = (kind: string, dir?: 'in' | 'out') =>
    linkRows.filter((l) => l.kind === kind && (!dir || l.dir === dir)).map(({ id, name }) => ({ id, name }));
  return {
    kind: base.kind ?? null,
    begin_date: base.begin_date ?? null,
    begin_precision: base.begin_precision ?? 'unknown',
    end_date: base.end_date ?? null,
    end_precision: base.end_precision ?? 'unknown',
    area: base.area ?? null,
    aliases: aliases!.results as { name: string; kind: string }[],
    memberOf: pick('member_of', 'out'),
    members: pick('member_of', 'in'),
    sameAs: pick('same_person'),
    bio: base.bio ?? null,
    bio_url: base.bio_url ?? null,
    occupations: list(base.occupations),
    instruments: list(base.instruments),
    urls: urls!.results as { kind: string; url: string }[],
    mbid: base.mbid ?? null,
    spotify_id: base.spotify_id ?? null,
    discogs_id: base.discogs_id ?? null,
  };
}

/** Age today, from a day-precise birth date; null otherwise or if they have died. */
export function ageOf(about: Pick<ArtistAbout, 'kind' | 'begin_date' | 'begin_precision' | 'end_date'>, now = new Date()): number | null {
  if (about.kind !== 'person' || about.begin_precision !== 'day' || !about.begin_date || about.end_date) return null;
  const born = new Date(`${about.begin_date}T00:00:00Z`);
  let age = now.getUTCFullYear() - born.getUTCFullYear();
  const before = now.getUTCMonth() < born.getUTCMonth() || (now.getUTCMonth() === born.getUTCMonth() && now.getUTCDate() < born.getUTCDate());
  if (before) age--;
  return age;
}

export interface ArtistGenre {
  id: string;
  name: string;
  /** How many of their tracks carry it. */
  tracks: number;
}

/**
 * What an artist makes, read off their own tracks (credited as the artist):
 * the genres those tracks carry, by how many carry them. A genre on fewer
 * than one in seven of their tracks is left out, so one odd song does not
 * label them.
 */
export async function artistGenres(artistId: string, limit = 6): Promise<ArtistGenre[]> {
  const { results } = await env.DB.prepare(
    `WITH theirs AS (
       SELECT DISTINCT entity_id AS recording_id FROM artist_credit
       WHERE artist_id = ?1 AND entity_type = 'recording' AND role = 'primary'
     )
     SELECT g.id, g.name, count(DISTINCT vg.recording_id) AS tracks
     FROM theirs t JOIN v_recording_genre vg ON vg.recording_id = t.recording_id
     JOIN genre g ON g.id = vg.genre_id
     GROUP BY g.id
     HAVING count(DISTINCT vg.recording_id) * 7 >= (SELECT count(*) FROM theirs)
     ORDER BY tracks DESC, g.name
     LIMIT ?2`,
  )
    .bind(artistId, limit)
    .all<ArtistGenre>();
  return results;
}
