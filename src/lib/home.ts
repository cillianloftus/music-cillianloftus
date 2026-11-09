/**
 * The home page's shelves beyond the calendar: albums half-rated, best
 * tracks, best singles and EPs, the artists and genres rated highest, and
 * what has been played a lot but never rated. Reads only.
 */

import { env } from 'cloudflare:workers';
import { albumScores, byRank } from './album-scores';
import { genresOfRecordings } from './genres';
import { artistLines, releaseGroupsByIds, type CreditPart, type ReleaseGroupSummary } from './catalogue';

/** Albums by type, best first. */
export async function topByType(userId: string | null, types: string[], limit = 10): Promise<ReleaseGroupSummary[]> {
  // From the user's album scores (album-scores.ts): no query of its own.
  const scores = await albumScores(userId);
  const ids = Object.entries(scores)
    .filter(([, s]) => types.includes(s.type))
    .map(([id]) => id)
    // Fully rated albums rank ahead of a high score on one song (album-scores.ts).
    .sort(byRank(scores))
    .slice(0, limit);
  return byIds(ids, userId);
}

async function byIds(ids: string[], userId: string | null): Promise<ReleaseGroupSummary[]> {
  const albums = new Map((await releaseGroupsByIds(ids, userId)).map((a) => [a.id, a]));
  return ids.map((id) => albums.get(id)).filter((a): a is ReleaseGroupSummary => a !== undefined);
}

export interface InProgress {
  album: ReleaseGroupSummary;
  rated: number;
  total: number;
  /** The first track on the standard edition not rated yet. */
  nextId: string | null;
}

/**
 * Albums started but not finished: some tracks rated, not all. Closest to
 * done first. The counts are the album scores' (standard edition, skits
 * left out of both), so only the next track is looked up, for the albums
 * shown: counting every album's tracks read 43,000 rows.
 */
export async function inProgress(userId: string, limit = 10): Promise<InProgress[]> {
  const chosen = Object.entries(await albumScores(userId))
    .filter(([, s]) => s.tracks !== null && s.rated > 0 && s.rated < s.tracks && s.tracks >= 4)
    .map(([id, s]) => ({ id, rated: s.rated, total: s.tracks! }))
    .sort((a, b) => b.rated / b.total - a.rated / a.total || b.rated - b.total - (a.rated - a.total) || a.id.localeCompare(b.id))
    .slice(0, limit);
  if (chosen.length === 0) return [];
  const { results } = await env.DB.prepare(
    `SELECT c.release_group_id AS id,
            (SELECT t.recording_id FROM track t
             WHERE t.release_id = c.release_id
               AND t.recording_id NOT IN (SELECT recording_id FROM v_recording_score WHERE user_id = ?1)
               AND NOT EXISTS (SELECT 1 FROM recording_kind k WHERE k.recording_id = t.recording_id AND k.kind = 'skit')
             ORDER BY t.disc, t.position LIMIT 1) AS next_id
     FROM v_release_group_canonical c
     WHERE c.release_group_id IN (SELECT value FROM json_each(?2))`,
  )
    .bind(userId, JSON.stringify(chosen.map((c) => c.id)))
    .all<{ id: string; next_id: string | null }>();
  const next = new Map(results.map((r) => [r.id, r.next_id]));
  const albums = new Map((await byIds(chosen.map((c) => c.id), userId)).map((a) => [a.id, a]));
  return chosen.flatMap((c) => (albums.get(c.id) ? [{ album: albums.get(c.id)!, rated: c.rated, total: c.total, nextId: next.get(c.id) ?? null }] : []));
}

export interface TrackCard {
  id: string;
  title: string;
  art_key: string | null;
  album_id: string | null;
  album_title: string | null;
  quality_score: number | null;
  personal_score: number | null;
  plays?: number;
  credits: CreditPart[];
}

async function withCredits<T extends { id: string }>(rows: T[]): Promise<(T & { credits: CreditPart[] })[]> {
  const lines = await artistLines('recording', rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, credits: lines.get(r.id) ?? [] }));
}

/** The cover a track first came out under, then its album's. */
const FIRST_ART = `coalesce((SELECT fa.art_key FROM v_recording_first_art fa WHERE fa.recording_id = r.id), x.art_key)`;

/**
 * Favourite tracks: one per song (versions of one work collapse), best
 * first. The first-release art is looked up for the tracks shown only:
 * per rated track it cost seconds on a full library.
 */
export async function topTracks(userId: string | null, limit = 12): Promise<TrackCard[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, title, coalesce((SELECT fa.art_key FROM v_recording_first_art fa WHERE fa.recording_id = top.id), top.album_art) AS art_key,
            album_id, album_title, quality_score, personal_score
     FROM (
       SELECT * FROM (
         SELECT r.id, r.title, x.art_key AS album_art, g.id AS album_id, g.title AS album_title,
                s.quality_score, s.personal_score,
                row_number() OVER (PARTITION BY coalesce(r.work_id, r.id) ORDER BY s.personal_score DESC) AS n
         FROM v_recording_score s JOIN recording r ON r.id = s.recording_id
         LEFT JOIN v_recording_album ra ON ra.recording_id = r.id
         LEFT JOIN release_group g ON g.id = ra.release_group_id
         LEFT JOIN v_release_group_canonical gc ON gc.release_group_id = g.id
         LEFT JOIN release x ON x.id = gc.release_id
         WHERE s.user_id = ?1)
       WHERE n = 1 ORDER BY personal_score DESC, quality_score DESC LIMIT ?2) top
     ORDER BY personal_score DESC, quality_score DESC`,
  )
    .bind(userId, limit)
    .all<Omit<TrackCard, 'credits'>>();
  return withCredits(results);
}

/** Played most (from listening history) and never rated. */
export async function playedNotRated(userId: string, limit = 10): Promise<TrackCard[]> {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.title, ${FIRST_ART} AS art_key, g.id AS album_id, g.title AS album_title,
            NULL AS quality_score, NULL AS personal_score, count(*) AS plays
     FROM play p JOIN recording r ON r.id = p.recording_id
     LEFT JOIN v_recording_album ra ON ra.recording_id = r.id
     LEFT JOIN release_group g ON g.id = ra.release_group_id
     LEFT JOIN v_release_group_canonical gc ON gc.release_group_id = g.id
     LEFT JOIN release x ON x.id = gc.release_id
     WHERE p.user_id = ?1 AND p.counted = 1
       AND NOT EXISTS (SELECT 1 FROM v_recording_score s WHERE s.recording_id = r.id AND s.user_id = ?1)
     GROUP BY r.id ORDER BY plays DESC LIMIT ?2`,
  )
    .bind(userId, limit)
    .all<Omit<TrackCard, 'credits'>>();
  return withCredits(results);
}

export interface LovedArtist {
  id: string;
  name: string;
  image_key: string | null;
  art_key: string | null;
  average: number;
  tracks: number;
}

/** Artists rated highest, with at least three rated tracks of their own. */
export async function lovedArtists(userId: string | null, limit = 12): Promise<LovedArtist[]> {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.name,
            (SELECT i.key FROM artist_image i WHERE i.artist_id = a.id AND i.hidden = 0 ORDER BY i.position, i.key LIMIT 1) AS image_key,
            (SELECT x.art_key FROM artist_credit c2 JOIN v_release_group_canonical v ON v.release_group_id = c2.entity_id
             JOIN release x ON x.id = v.release_id JOIN release_group g ON g.id = c2.entity_id
             WHERE c2.artist_id = a.id AND c2.entity_type = 'release_group' AND c2.role = 'primary' AND x.art_key IS NOT NULL
             ORDER BY g.first_release_date DESC LIMIT 1) AS art_key,
            avg(s.quality_score) AS average, count(*) AS tracks
     FROM artist_credit c JOIN artist a ON a.id = c.artist_id
     JOIN v_recording_score s ON s.recording_id = c.entity_id AND s.user_id = ?1
     WHERE c.entity_type = 'recording' AND c.role = 'primary'
     GROUP BY a.id HAVING count(*) >= 3
     ORDER BY average DESC, tracks DESC LIMIT ?2`,
  )
    .bind(userId, limit)
    .all<LovedArtist>();
  return results;
}

export interface LovedGenre {
  id: string;
  name: string;
  average: number;
  tracks: number;
}

/** Genres rated highest, with at least three rated tracks. */
export async function lovedGenres(userId: string | null, limit = 12): Promise<LovedGenre[]> {
  // From the rated tracks to their genres (genresOfRecordings), not the
  // genre view joined whole: 92,000 rows read, now about 19,000.
  const { results } = await env.DB.prepare(
    `WITH scored AS (SELECT recording_id, quality_score FROM v_recording_score WHERE user_id = ?1),
     pairs AS (${genresOfRecordings('scored')})
     SELECT g.id, g.name, avg(s.quality_score) AS average, count(*) AS tracks
     FROM pairs p JOIN scored s ON s.recording_id = p.recording_id JOIN genre g ON g.id = p.genre_id
     GROUP BY g.id HAVING tracks >= 3
     ORDER BY average DESC, tracks DESC LIMIT ?2`,
  )
    .bind(userId, limit)
    .all<LovedGenre>();
  return results;
}
