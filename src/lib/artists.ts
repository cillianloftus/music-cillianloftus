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
import { byLibrary } from './library-cache';
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
  /** The years each membership held, by the other artist's MBID (the earliest start, the latest end). */
  memberYears: Record<string, { begin: number | null; end: number | null }>;
}

const yearOf = (d: string | null | undefined) => (d && /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : null);

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
  // Someone who left and came back has two spells: from the first start to the last end.
  const memberYears: Enrichment['memberYears'] = {};
  for (const r of memberRels) {
    const id = r.artist!.id;
    const begin = yearOf(r.begin);
    const end = yearOf(r.end);
    const had = memberYears[id];
    memberYears[id] = had
      ? { begin: had.begin === null || begin === null ? (had.begin ?? begin) : Math.min(had.begin, begin), end: had.end === null ? null : end === null ? null : Math.max(had.end, end) }
      : { begin, end };
  }

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
    memberYears,
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
    // Members and groups, where both are in the catalogue, with the years it held.
    db.prepare(
      `INSERT INTO artist_link (artist_id, other_id, kind, source, begin_year, end_year)
       SELECT a.id, ?1, 'member_of', 'musicbrainz', j.value ->> '$.begin', j.value ->> '$.end'
       FROM json_each(?2) j JOIN artist a ON a.mbid = j.value ->> '$.mbid'
       WHERE a.id <> ?1
       ON CONFLICT DO UPDATE SET begin_year = coalesce(begin_year, excluded.begin_year), end_year = coalesce(end_year, excluded.end_year)`,
    ).bind(artistId, JSON.stringify(e.members.map((mbid) => ({ mbid, ...e.memberYears[mbid] })))),
    db.prepare(
      `INSERT INTO artist_link (artist_id, other_id, kind, source, begin_year, end_year)
       SELECT ?1, a.id, 'member_of', 'musicbrainz', j.value ->> '$.begin', j.value ->> '$.end'
       FROM json_each(?2) j JOIN artist a ON a.mbid = j.value ->> '$.mbid'
       WHERE a.id <> ?1
       ON CONFLICT DO UPDATE SET begin_year = coalesce(begin_year, excluded.begin_year), end_year = coalesce(end_year, excluded.end_year)`,
    ).bind(artistId, JSON.stringify(e.memberOf.map((mbid) => ({ mbid, ...e.memberYears[mbid] })))),
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
export async function enrichArtists({
  budgetMs,
  limit = 40,
  count = false,
}: {
  budgetMs: number;
  limit?: number;
  /** Also count how many are still due (for a catch-up that runs until none are). */
  count?: boolean;
}): Promise<{ done: number; left: number }> {
  const deadline = Date.now() + budgetMs;
  const waiting = `FROM artist a
     WHERE a.mbid IS NOT NULL
       AND (a.enriched_at IS NULL OR a.enriched_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days'))`;
  // Artists with records of their own first, then everyone else credited.
  // Two short reads that stop once they have enough, where sorting every
  // due artist by whether they had a record read about 11,000 rows a time.
  const { results: primary } = await env.DB.prepare(
    `SELECT a.id ${waiting}
       AND EXISTS (SELECT 1 FROM artist_credit c WHERE c.artist_id = a.id AND c.role = 'primary')
     LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string }>();
  const { results: others } =
    primary.length < limit
      ? await env.DB.prepare(`SELECT a.id ${waiting} AND a.id NOT IN (SELECT value FROM json_each(?1)) LIMIT ?2`)
          .bind(JSON.stringify(primary.map((p) => p.id)), limit - primary.length)
          .all<{ id: string }>()
      : { results: [] as { id: string }[] };
  const results = [...primary, ...others];
  let done = 0;
  for (const { id } of results) {
    if (Date.now() > deadline) break;
    try {
      if (await enrichArtist(id)) done++;
    } catch (error) {
      console.warn('Artist enrichment failed', id, error);
    }
  }
  const left = count ? ((await env.DB.prepare(`SELECT count(*) AS n ${waiting}`).first<{ n: number }>())?.n ?? 0) : 0;
  return { done, left };
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
  memberOf: { id: string; name: string; years: string | null }[];
  members: { id: string; name: string; years: string | null }[];
  sameAs: { id: string; name: string; years: string | null }[];
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
  /** Awards, labels, influences, places, from Wikidata. */
  facts: ArtistFact[];
  /** Artists here who name this one as an influence. */
  influenced: { id: string; name: string }[];
}

export interface ArtistFact {
  property: 'award' | 'nomination' | 'label' | 'influenced_by' | 'birthplace' | 'deathplace' | 'educated_at' | 'citizenship' | 'nickname';
  label: string;
  year: number | null;
  /** The artist here it names, for an influence. */
  artist_id: string | null;
}

/** A membership's years: '1985–1999', '2003–' (still), '1999' (one year), or null when unknown. */
export function spanOf(begin: number | null, end: number | null): string | null {
  if (begin === null) return end === null ? null : `until ${end}`;
  if (end === null) return `${begin}–`;
  return begin === end ? String(begin) : `${begin}–${end}`;
}

export async function artistAbout(artistId: string): Promise<ArtistAbout> {
  const [row, aliases, links, urls, factRows, influencedRows] = await env.DB.batch([
    env.DB.prepare(
      `SELECT kind, begin_date, begin_precision, end_date, end_precision, area, bio, bio_url, occupations, instruments, mbid, spotify_id, discogs_id
       FROM artist WHERE id = ?`,
    ).bind(artistId),
    env.DB.prepare(
      `SELECT name, kind FROM artist_alias WHERE artist_id = ?
       ORDER BY CASE kind WHEN 'legal' THEN 0 WHEN 'performance' THEN 1 WHEN 'alias' THEN 2 ELSE 3 END, name`,
    ).bind(artistId),
    env.DB.prepare(
      `SELECT l.kind, 'out' AS dir, a.id, a.name, l.begin_year, l.end_year FROM artist_link l JOIN artist a ON a.id = l.other_id WHERE l.artist_id = ?1
       UNION ALL
       SELECT l.kind, 'in' AS dir, a.id, a.name, l.begin_year, l.end_year FROM artist_link l JOIN artist a ON a.id = l.artist_id WHERE l.other_id = ?1
       ORDER BY 4`,
    ).bind(artistId),
    env.DB.prepare(
      `SELECT kind, url FROM artist_url WHERE artist_id = ?
       ORDER BY CASE kind WHEN 'website' THEN 0 WHEN 'bandcamp' THEN 1 WHEN 'instagram' THEN 2 WHEN 'youtube' THEN 3 ELSE 4 END, kind`,
    ).bind(artistId),
    // From Wikidata (migration 0056); an influence that is an artist here leads to them.
    env.DB.prepare(
      `SELECT f.property, f.label, f.year,
              CASE WHEN f.property = 'influenced_by' THEN (SELECT a.id FROM artist a WHERE a.wikidata_id = f.value_id LIMIT 1) END AS artist_id
       FROM artist_fact f WHERE f.artist_id = ?
       ORDER BY f.property, f.year IS NULL, f.year DESC, f.label`,
    ).bind(artistId),
    // Artists here who name this one as an influence.
    env.DB.prepare(
      `SELECT a.id, a.name FROM artist me
       JOIN artist_fact f ON f.property = 'influenced_by' AND f.value_id = me.wikidata_id
       JOIN artist a ON a.id = f.artist_id
       WHERE me.id = ? ORDER BY a.name`,
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
  const linkRows = links!.results as { kind: string; dir: 'in' | 'out'; id: string; name: string; begin_year: number | null; end_year: number | null }[];
  const pick = (kind: string, dir?: 'in' | 'out') =>
    linkRows.filter((l) => l.kind === kind && (!dir || l.dir === dir)).map(({ id, name, begin_year, end_year }) => ({ id, name, years: spanOf(begin_year, end_year) }));
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
    facts: factRows!.results as ArtistFact[],
    influenced: influencedRows!.results as { id: string; name: string }[],
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
  // The library's, not anyone's ratings: kept until it changes.
  return byLibrary(`artist-genres:v1:${artistId}:${limit}`, null, () => findArtistGenres(artistId, limit));
}

async function findArtistGenres(artistId: string, limit: number): Promise<ArtistGenre[]> {
  // v_recording_genre's rule, driven from this artist's credits and counted
  // here: a track's own tags (manual ones winning) if it has any, otherwise
  // its albums'. Through the view it was 158,000 rows read for an artist
  // with 2,000 tracks; as two plain reads, about 27,000.
  const [count, own, inherited] = await env.DB.batch([
    env.DB.prepare(
      `SELECT count(DISTINCT entity_id) AS n FROM artist_credit
       WHERE artist_id = ?1 AND entity_type = 'recording' AND role = 'primary'`,
    ).bind(artistId),
    env.DB.prepare(
      `SELECT DISTINCT t.entity_id AS recording_id, t.genre_id, t.source = 'manual' AS manual
       FROM artist_credit c
       JOIN genre_tag t ON t.entity_type = 'recording' AND t.entity_id = c.entity_id
       WHERE c.artist_id = ?1 AND c.entity_type = 'recording' AND c.role = 'primary'`,
    ).bind(artistId),
    env.DB.prepare(
      `SELECT DISTINCT tr.recording_id, rg.genre_id
       FROM artist_credit c
       JOIN track tr ON tr.recording_id = c.entity_id
       JOIN release r ON r.id = tr.release_id
       JOIN v_release_group_genre rg ON rg.release_group_id = r.release_group_id
       WHERE c.artist_id = ?1 AND c.entity_type = 'recording' AND c.role = 'primary'`,
    ).bind(artistId),
  ]);
  const total = (count?.results[0] as { n: number } | undefined)?.n ?? 0;
  const ownRows = (own?.results ?? []) as { recording_id: string; genre_id: string; manual: number }[];
  const withManual = new Set(ownRows.filter((r) => r.manual).map((r) => r.recording_id));
  const tagged = new Set(ownRows.map((r) => r.recording_id));

  const tracksOf = new Map<string, Set<string>>();
  const add = (genre: string, recording: string) => {
    const set = tracksOf.get(genre) ?? new Set<string>();
    set.add(recording);
    tracksOf.set(genre, set);
  };
  for (const r of ownRows) if (r.manual || !withManual.has(r.recording_id)) add(r.genre_id, r.recording_id);
  for (const r of (inherited?.results ?? []) as { recording_id: string; genre_id: string }[]) {
    if (!tagged.has(r.recording_id)) add(r.genre_id, r.recording_id);
  }

  const kept = [...tracksOf]
    .map(([id, set]) => ({ id, tracks: set.size }))
    // A genre on fewer than one in seven of their tracks says little about them.
    .filter((g) => g.tracks * 7 >= total);
  if (kept.length === 0) return [];
  const names = new Map(
    (
      await env.DB.prepare(`SELECT id, name FROM genre WHERE id IN (SELECT value FROM json_each(?1))`)
        .bind(JSON.stringify(kept.map((g) => g.id)))
        .all<{ id: string; name: string }>()
    ).results.map((g) => [g.id, g.name]),
  );
  return kept
    .map((g) => ({ id: g.id, name: names.get(g.id) ?? '', tracks: g.tracks }))
    .sort((a, b) => b.tracks - a.tracks || a.name.localeCompare(b.name))
    .slice(0, limit);
}
