/**
 * Read queries for public catalogue pages. Scores come from the views in
 * migrations/0003 for one viewer: the signed-in user, else the owner.
 */

import { env } from 'cloudflare:workers';
import { albumScores, withScores, type Completeness } from './album-scores';
import { byLibrary, byLibraryMap } from './library-cache';
import { splitVersion } from './versions';
import type { DatePrecision } from './dates';
import type { CreditEntity, CreditRole, ReleaseGroupType } from './import/plan';

export interface CreditPart {
  entity_id: string;
  artist_id: string;
  name: string;
  role: CreditRole;
  join_phrase: string;
}

export interface Score {
  quality_score: number;
  personal_score: number;
}

export interface ReleaseGroupSummary extends Partial<Score> {
  /** What albums are ranked by: the score, as sure as the rating is complete (album-scores.ts). */
  rank_score?: number | null;
  /** How much of it is rated, when not all of it. */
  completeness?: Completeness | null;
  id: string;
  title: string;
  type: ReleaseGroupType;
  status: 'announced' | 'released' | 'cancelled';
  first_release_date: string | null;
  date_precision: DatePrecision;
  art_key: string | null;
  credits: CreditPart[];
}

const json = (value: unknown) => JSON.stringify(value);

/**
 * The displayed artist line (primary, then featured) for many entities in
 * one query, in credit order with join phrases intact.
 */
export async function artistLines(
  entityType: CreditEntity,
  ids: string[],
): Promise<Map<string, CreditPart[]>> {
  const lines = new Map<string, CreditPart[]>();
  if (ids.length === 0) return lines;

  const { results } = await env.DB.prepare(
    `SELECT c.entity_id, c.artist_id, coalesce(c.credited_as, a.name) AS name, c.role, c.join_phrase
     FROM artist_credit c
     JOIN artist a ON a.id = c.artist_id
     WHERE c.entity_type = ?1
       AND c.entity_id IN (SELECT value FROM json_each(?2))
       AND c.role IN ('primary', 'featured')
     ORDER BY c.entity_id, c.role = 'featured', c.position`,
  )
    .bind(entityType, json(ids))
    .all<CreditPart>();

  for (const part of results) {
    const line = lines.get(part.entity_id) ?? [];
    // Sources sometimes credit one artist as both artist and featured guest.
    if (part.role === 'featured' && line.some((p) => p.artist_id === part.artist_id)) continue;
    line.push(part);
    lines.set(part.entity_id, line);
  }
  return lines;
}

/** Follows a merge redirect, if the id was merged away. */
export async function redirectFor(entityType: string, id: string): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT new_id FROM entity_redirect WHERE entity_type = ? AND old_id = ?',
  )
    .bind(entityType, id)
    .first<{ new_id: string }>();
  return row?.new_id ?? null;
}

// Scores come from the viewer's album scores (album-scores.ts), not a join
// on v_release_score, which is built whole for every query that names it.
const SUMMARY_COLUMNS = `
  g.id, g.title, g.type, g.status, g.first_release_date, g.date_precision, r.art_key`;

const SUMMARY_JOINS = `
  LEFT JOIN v_release_group_canonical c ON c.release_group_id = g.id
  LEFT JOIN release r ON r.id = c.release_id`;

type SummaryRow = Omit<ReleaseGroupSummary, 'credits' | 'quality_score' | 'personal_score'>;

/** Rows with the viewer's scores and their artist lines. */
async function withArtistLines(rows: SummaryRow[], viewerId: string | null): Promise<ReleaseGroupSummary[]> {
  const [lines, scores] = await Promise.all([artistLines('release_group', rows.map((row) => row.id)), albumScores(viewerId)]);
  // Unscored is null, as the join gave it (the type says optional).
  return withScores(rows, scores).map((row) => ({ ...row, credits: lines.get(row.id) ?? [] })) as ReleaseGroupSummary[];
}

export async function recentReleaseGroups(viewerId: string | null, limit = 24): Promise<ReleaseGroupSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${SUMMARY_COLUMNS}
     FROM release_group g ${SUMMARY_JOINS}
     WHERE coalesce(g.official, 1) = 1 OR g.keep_unofficial = 1
     ORDER BY g.created_at DESC
     LIMIT ?2`,
  )
    .bind(viewerId, limit)
    .all<SummaryRow>();
  return withArtistLines(results, viewerId);
}

export async function releaseGroupsByIds(ids: string[], viewerId: string | null): Promise<ReleaseGroupSummary[]> {
  if (ids.length === 0) return [];
  const { results } = await env.DB.prepare(
    `SELECT ${SUMMARY_COLUMNS}
     FROM release_group g ${SUMMARY_JOINS}
     WHERE g.id IN (SELECT value FROM json_each(?2))`,
  )
    .bind(viewerId, JSON.stringify(ids))
    .all<SummaryRow>();
  return withArtistLines(results, viewerId);
}

export interface ReleaseGroupDetail extends ReleaseGroupSummary {
  mbid: string | null;
  availability: string | null;
  canonical_release_id: string | null;
  rated_track_count: number | null;
  track_count: number | null;
  impact_note: string | null;
}

export async function releaseGroup(id: string, viewerId: string | null): Promise<ReleaseGroupDetail | null> {
  const row = await env.DB.prepare(
    `SELECT ${SUMMARY_COLUMNS}, g.mbid, g.availability, c.release_id AS canonical_release_id,
            (SELECT lr.impact_note FROM rating lr
             WHERE lr.user_id = ?1 AND lr.entity_type = 'release_group' AND lr.entity_id = g.id
             ORDER BY lr.rated_at DESC LIMIT 1) AS impact_note
     FROM release_group g ${SUMMARY_JOINS}
     WHERE g.id = ?2`,
  )
    .bind(viewerId, id)
    .first<Omit<ReleaseGroupDetail, 'credits' | 'quality_score' | 'personal_score' | 'rated_track_count' | 'track_count'>>();
  if (!row) return null;
  const [[withLine], scores] = await Promise.all([withArtistLines([row], viewerId), albumScores(viewerId)]);
  return { ...row, ...withLine!, rated_track_count: scores[id]?.rated ?? null, track_count: scores[id]?.tracks ?? null };
}

export interface TrackRow extends Partial<Score> {
  id: string;
  disc: number;
  position: number;
  title: string;
  recording_id: string;
  length_ms: number | null;
  depth: 'gut' | 'detailed' | null;
  credits: CreditPart[];
}

/** An album's standard edition, track by track: what its score is taken from. */
export async function standardTracklist(albumId: string, viewerId: string | null): Promise<TrackRow[]> {
  const row = await env.DB.prepare(`SELECT release_id FROM v_release_group_canonical WHERE release_group_id = ?`)
    .bind(albumId)
    .first<{ release_id: string | null }>();
  return row?.release_id ? tracklist(row.release_id, viewerId) : [];
}

export async function tracklist(releaseId: string, viewerId: string | null): Promise<TrackRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.disc, t.position, coalesce(t.title_on_release, rec.title) AS title,
            rec.id AS recording_id, rec.length_ms,
            s.quality_score, s.personal_score, s.depth
     FROM track t
     JOIN recording rec ON rec.id = t.recording_id
     LEFT JOIN v_recording_score s ON s.recording_id = rec.id AND s.user_id = ?2
     WHERE t.release_id = ?1
     ORDER BY t.disc, t.position`,
  )
    .bind(releaseId, viewerId)
    .all<Omit<TrackRow, 'credits'>>();

  const lines = await artistLines('recording', results.map((row) => row.recording_id));
  return results.map((row) => ({ ...row, credits: lines.get(row.recording_id) ?? [] }));
}

export interface Edition {
  id: string;
  title: string;
  date: string | null;
  date_precision: DatePrecision;
  country: string | null;
  label: string | null;
  format: string | null;
  mbid: string | null;
  art_key: string | null;
  track_count: number;
  /** "Pulled from streaming in 2024": anything about it no field holds. */
  note: string | null;
}

/** Ordered the same way v_release_group_canonical chooses, so the standard edition comes first. */
export async function editions(releaseGroupId: string): Promise<Edition[]> {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.title, r.date, r.date_precision, r.country, r.label, r.format, r.mbid, r.art_key, r.note,
            (SELECT count(*) FROM track t WHERE t.release_id = r.id) AS track_count
     FROM release r
     WHERE r.release_group_id = ?
     ORDER BY (lower(r.title) GLOB '*deluxe*' OR lower(r.title) GLOB '*special*' OR lower(r.title) GLOB '*expanded*'
               OR lower(r.title) GLOB '*anniversary*' OR lower(r.title) GLOB '*remaster*' OR lower(r.title) GLOB '*bonus*'
               OR lower(r.title) GLOB '*edition*' OR lower(r.title) GLOB '*collector*'),
              r.date IS NULL, substr(r.date || '-99-99', 1, 10), track_count, r.created_at, r.id`,
  )
    .bind(releaseGroupId)
    .all<Edition>();
  return results;
}

export interface Genre {
  id: string;
  name: string;
}

export async function genresFor(entityType: 'release_group' | 'recording', id: string): Promise<Genre[]> {
  // Manual tags win: when any exist, other sources are not shown.
  const { results } = await env.DB.prepare(
    `WITH tags AS (
       SELECT t.genre_id, t.source, t.weight FROM genre_tag t
       WHERE t.entity_type = ?1 AND t.entity_id = ?2
     )
     SELECT g.id, g.name
     FROM tags t JOIN genre g ON g.id = t.genre_id
     WHERE t.source = 'manual' OR NOT EXISTS (SELECT 1 FROM tags WHERE source = 'manual')
     GROUP BY g.id
     ORDER BY max(t.source = 'manual') DESC, max(t.weight) DESC, g.name`,
  )
    .bind(entityType, id)
    .all<Genre>();
  return results;
}

/**
 * A track's genres as everything else counts them (v_recording_genre):
 * its own, or, with none of its own, its album's. `inherited` says which.
 */
export async function trackGenres(id: string): Promise<{ genres: Genre[]; inherited: boolean }> {
  const own = await genresFor('recording', id);
  if (own.length > 0) return { genres: own, inherited: false };
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.name FROM v_recording_genre vg JOIN genre g ON g.id = vg.genre_id
     WHERE vg.recording_id = ? GROUP BY g.id ORDER BY max(vg.weight) DESC, g.name`,
  )
    .bind(id)
    .all<Genre>();
  return { genres: results, inherited: results.length > 0 };
}

export interface Contributor {
  artist_id: string;
  name: string;
  role: CreditRole;
  role_label: string;
  family: string;
  key_order: number | null;
  /** How many of the edition's tracks credit them in this role. */
  tracks: number;
  /** How many tracks the edition has. */
  of: number;
}

/**
 * An album's writers, producers, engineers and players: entirely its
 * tracks', gathered across the edition, most-credited first in each role.
 */
export async function contributors(releaseId: string): Promise<Contributor[]> {
  const { results } = await env.DB.prepare(
    `WITH tracks AS (SELECT DISTINCT recording_id FROM track WHERE release_id = ?1)
     SELECT a.id AS artist_id, a.name, c.role, r.label AS role_label, r.family, r.key_order,
            count(DISTINCT c.entity_id) AS tracks, (SELECT count(*) FROM tracks) AS "of"
     FROM artist_credit c
     JOIN artist a ON a.id = c.artist_id
     JOIN credit_role r ON r.id = c.role
     WHERE c.entity_type = 'recording' AND c.entity_id IN (SELECT recording_id FROM tracks)
       AND r.family <> 'artist'
     GROUP BY c.role, a.id
     ORDER BY r.key_order IS NULL, r.key_order, r.position, r.label, tracks DESC, a.sort_name`,
  )
    .bind(releaseId)
    .all<Contributor>();
  return results;
}

export interface ArtistDetail {
  id: string;
  name: string;
  disambiguation: string | null;
  mbid: string | null;
}

export async function artist(id: string): Promise<ArtistDetail | null> {
  return env.DB.prepare('SELECT id, name, disambiguation, mbid FROM artist WHERE id = ?')
    .bind(id)
    .first<ArtistDetail>();
}

export async function artistReleaseGroups(artistId: string, viewerId: string | null): Promise<ReleaseGroupSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${SUMMARY_COLUMNS}
     FROM release_group g ${SUMMARY_JOINS}
     WHERE g.id IN (
       SELECT entity_id FROM artist_credit
       WHERE entity_type = 'release_group' AND artist_id = ?2 AND role IN ('primary', 'featured')
     )
       -- Bootlegs and fan-made releases stay off the page while they wait
       -- to be cleared on Manage › Not official, unless kept on purpose.
       AND (coalesce(g.official, 1) = 1 OR g.keep_unofficial = 1)
     ORDER BY g.first_release_date IS NULL, g.first_release_date DESC`,
  )
    .bind(viewerId, artistId)
    .all<SummaryRow>();
  return withArtistLines(results, viewerId);
}

/** How many of an artist's releases are hidden as not official, waiting to be cleared. */
export async function hiddenUnofficial(artistId: string): Promise<number> {
  return (
    (await env.DB.prepare(
      `SELECT count(*) AS n FROM release_group g
       WHERE g.official = 0 AND g.keep_unofficial = 0
         AND g.id IN (SELECT entity_id FROM artist_credit WHERE entity_type = 'release_group' AND artist_id = ? AND role IN ('primary', 'featured'))`,
    )
      .bind(artistId)
      .first<number>('n')) ?? 0
  );
}

/** Credits on other people's records: production, writing, features. */
/**
 * What else an artist is credited as, beyond being the artist: most often
 * first, and on a tie the weightier role first (writer before producer
 * before engineer), as the role list orders them. Labels as stored.
 */
export async function artistAppearances(
  artistId: string,
): Promise<{ role: CreditRole; label: string; family: string; key_order: number | null; count: number }[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.role, r.label, r.family, r.key_order, count(DISTINCT c.entity_id) AS count
     FROM artist_credit c JOIN credit_role r ON r.id = c.role
     WHERE c.artist_id = ? AND c.role <> 'primary'
     GROUP BY c.role
     ORDER BY count DESC, r.position, r.label`,
  )
    .bind(artistId)
    .all<{ role: CreditRole; label: string; family: string; key_order: number | null; count: number }>();
  return results;
}

export interface ArtistTrack {
  id: string;
  title: string;
  quality_score: number | null;
  personal_score: number | null;
  album_id: string | null;
  album_title: string | null;
  art_key: string | null;
  /** Plays from listening history (Spotify export, Last.fm, ListenBrainz). */
  plays: number;
}

/**
 * How much of a favourite a track is: the rating, balanced against how
 * often it is played, each out of 100. Plays count on a log scale against
 * the artist's most played track, so the hundredth play adds less than the
 * tenth. Until there is any listening history for the artist it is the
 * rating alone; a track played a lot but not yet rated still makes the list.
 */
export function favouriteScore(rating: number | null, plays: number, mostPlays: number): number {
  if (mostPlays <= 0) return rating ?? 0;
  const played = (Math.log1p(plays) / Math.log1p(mostPlays)) * 100;
  if (rating === null) return played * 0.85;
  return rating * 0.6 + played * 0.4;
}

/** How many favourite tracks an artist page shows at a time. */
export const TRACKS_PER_PAGE = 10;

type RankedTrack = Pick<ArtistTrack, 'id' | 'title' | 'quality_score' | 'personal_score' | 'plays'>;
export type TrackPlace = Pick<ArtistTrack, 'album_id' | 'album_title' | 'art_key'>;

/**
 * An artist's favourite recordings, as primary artist: rated highly,
 * played a lot, or both. One stretch of them in favourite order (from, then up to
 * limit), and how many there are in all: the artist page shows ten and
 * fetches the rest as they are paged through. Ranked first on what decides
 * it (score and plays), kept for this state of the viewer's ratings; then
 * the album and cover looked up only for the stretch shown, and kept per
 * library state, since a rating moves neither. Working those out for every
 * rated or played track at once read 67,000 rows for an artist with 2,000.
 */
export async function artistTracks(
  artistId: string,
  viewerId: string | null,
  from: number,
  limit: number,
): Promise<{ tracks: ArtistTrack[]; total: number }> {
  const ranked = await byLibrary(`artist-ranking:v1:${artistId}`, viewerId, () => rankArtistTracks(artistId, viewerId));
  const stretch = ranked.slice(from, from + limit);
  if (stretch.length === 0) return { tracks: [], total: ranked.length };
  const places = await trackPlaces(stretch.map((t) => t.id));
  return {
    tracks: stretch.map((t) => ({ ...t, album_id: null, album_title: null, art_key: null, ...places[t.id] })),
    total: ranked.length,
  };
}

async function rankArtistTracks(artistId: string, viewerId: string | null): Promise<RankedTrack[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM (
       SELECT r.id, r.title, s.quality_score, s.personal_score,
              (SELECT count(*) FROM play p WHERE p.user_id = ?1 AND p.recording_id = r.id AND p.counted = 1) AS plays
       FROM artist_credit c
       JOIN recording r ON r.id = c.entity_id
       LEFT JOIN v_recording_score s ON s.recording_id = r.id AND s.user_id = ?1
       WHERE c.entity_type = 'recording' AND c.artist_id = ?2 AND c.role = 'primary'
     ) WHERE quality_score IS NOT NULL OR plays > 0`,
  )
    .bind(viewerId, artistId)
    .all<RankedTrack>();
  const most = Math.max(0, ...results.map((t) => t.plays));
  return results
    .map((t) => ({ t, favour: favouriteScore(t.personal_score, t.plays, most) }))
    .sort((a, b) => b.favour - a.favour || (b.t.quality_score ?? 0) - (a.t.quality_score ?? 0) || a.t.title.localeCompare(b.t.title))
    .map(({ t }) => t);
}

/**
 * Where each of some recordings sits (its album, and the cover it first
 * came out under), kept per library state and grown a track at a time:
 * for any list of tracks that shows their covers.
 */
export function trackPlaces(ids: string[]): Promise<Record<string, TrackPlace | null>> {
  return byLibraryMap<TrackPlace>('track-place:v1', null, ids, placeTracks);
}

/** Where each recording sits: its album, and the cover it first came out under. */
async function placeTracks(ids: string[]): Promise<Record<string, TrackPlace>> {
  const { results: placed } = await env.DB.prepare(
    `SELECT t.value AS id, ra.release_group_id AS album_id, g.title AS album_title,
            -- The cover it first came out under: a single's, before the album's.
            coalesce((SELECT fa.art_key FROM v_recording_first_art fa WHERE fa.recording_id = t.value), x.art_key) AS art_key
     FROM json_each(?1) t
     LEFT JOIN v_recording_album ra ON ra.recording_id = t.value
     LEFT JOIN release_group g ON g.id = ra.release_group_id
     LEFT JOIN v_release_group_canonical gc ON gc.release_group_id = g.id
     LEFT JOIN release x ON x.id = gc.release_id`,
  )
    .bind(JSON.stringify(ids))
    .all<TrackPlace & { id: string }>();
  return Object.fromEntries(placed.map(({ id, ...place }) => [id, place]));
}

export interface Collaborator {
  id: string;
  name: string;
  /** Recordings or releases of this artist's that credit them. */
  count: number;
}

/** Who appears most on this artist's own records, in any role but their own. */
export async function artistCollaborators(artistId: string, limit = 8): Promise<Collaborator[]> {
  // The library's, not anyone's ratings: kept until it changes (30,000 rows for a big artist).
  return byLibrary(`collaborators:v1:${artistId}:${limit}`, null, () => findCollaborators(artistId, limit));
}

async function findCollaborators(artistId: string, limit: number): Promise<Collaborator[]> {
  const { results } = await env.DB.prepare(
    `WITH own AS (
       SELECT entity_type, entity_id FROM artist_credit WHERE artist_id = ?1 AND role = 'primary'
     )
     SELECT a.id, a.name, count(DISTINCT c.entity_type || c.entity_id) AS count
     FROM own o
     JOIN artist_credit c ON c.entity_type = o.entity_type AND c.entity_id = o.entity_id
     JOIN artist a ON a.id = c.artist_id
     WHERE c.artist_id <> ?1
     GROUP BY a.id
     ORDER BY count DESC, a.name
     LIMIT ?2`,
  )
    .bind(artistId, limit)
    .all<Collaborator>();
  return results;
}

export type ShelfKind = 'albums' | 'eps' | 'singles' | 'other';
export type ShelfSort = 'score' | 'newest' | 'added' | 'name';

const SHELF_TYPES: Record<ShelfKind, string[]> = {
  albums: ['album', 'mixtape'],
  eps: ['ep'],
  singles: ['single'],
  other: ['live', 'compilation', 'soundtrack'],
};

const SHELF_ORDER: Record<ShelfSort, string> = {
  // Then by score, below (scores are not in the query).
  score: 'g.first_release_date DESC',
  newest: 'g.first_release_date IS NULL, g.first_release_date DESC, g.title COLLATE NOCASE',
  added: 'g.created_at DESC',
  name: 'g.title COLLATE NOCASE',
};

/**
 * Every release of one kind in the library, in one order: the Albums
 * page. Not-official releases waiting to be cleared are left out, and so
 * are remix singles and EPs, which live with their songs.
 */
export async function shelfOfKind(viewerId: string | null, kind: ShelfKind, sort: ShelfSort): Promise<ReleaseGroupSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${SUMMARY_COLUMNS}
     FROM release_group g ${SUMMARY_JOINS}
     WHERE g.type IN (SELECT value FROM json_each(?2))
       AND (coalesce(g.official, 1) = 1 OR g.keep_unofficial = 1)
     ORDER BY ${SHELF_ORDER[sort]}`,
  )
    .bind(viewerId, json(SHELF_TYPES[kind]))
    .all<SummaryRow>();
  // The same test as the artist page's "Remixes and versions" shelf.
  const versions = kind === 'singles' || kind === 'eps';
  const shelf = await withArtistLines(versions ? results.filter((g) => splitVersion(g.title).version === null) : results, viewerId);
  // Scored first, best first; the query's order (newest) breaks ties. Stable.
  if (sort === 'score') shelf.sort((a, b) => (a.rank_score === null ? 1 : 0) - (b.rank_score === null ? 1 : 0) || (b.rank_score ?? 0) - (a.rank_score ?? 0));
  return shelf;
}
