/**
 * The home page's shelves beyond the calendar: albums half-rated, best
 * tracks, best singles and EPs, the artists and genres rated highest, and
 * what has been played a lot but never rated. Reads only.
 */

import { env } from 'cloudflare:workers';
import { artistLines, releaseGroupsByIds, type CreditPart, type ReleaseGroupSummary } from './catalogue';

/** Albums by type, best first. */
export async function topByType(userId: string | null, types: string[], limit = 10): Promise<ReleaseGroupSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.release_group_id AS id FROM v_release_score s JOIN release_group g ON g.id = s.release_group_id
     WHERE s.user_id = ?1 AND g.type IN (SELECT value FROM json_each(?2))
     ORDER BY s.quality_score DESC, s.personal_score DESC LIMIT ?3`,
  )
    .bind(userId, JSON.stringify(types), limit)
    .all<{ id: string }>();
  return byIds(results.map((r) => r.id), userId);
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

/** Albums started but not finished: some tracks rated, not all. Closest to done first. */
export async function inProgress(userId: string, limit = 10): Promise<InProgress[]> {
  const { results } = await env.DB.prepare(
    `WITH canon AS (
       SELECT v.release_group_id, t.recording_id, t.disc, t.position
       FROM v_release_group_canonical v JOIN track t ON t.release_id = v.release_id
     ),
     tally AS (
       SELECT c.release_group_id AS id, count(*) AS total, count(s.recording_id) AS rated,
              (SELECT c2.recording_id FROM canon c2
               LEFT JOIN v_recording_score s2 ON s2.recording_id = c2.recording_id AND s2.user_id = ?1
               WHERE c2.release_group_id = c.release_group_id AND s2.recording_id IS NULL
               ORDER BY c2.disc, c2.position LIMIT 1) AS next_id
       FROM canon c LEFT JOIN v_recording_score s ON s.recording_id = c.recording_id AND s.user_id = ?1
       GROUP BY c.release_group_id
     )
     SELECT id, total, rated, next_id FROM tally
     WHERE rated > 0 AND rated < total AND total >= 4
     ORDER BY 1.0 * rated / total DESC, total - rated LIMIT ?2`,
  )
    .bind(userId, limit)
    .all<{ id: string; total: number; rated: number; next_id: string | null }>();
  const albums = new Map((await byIds(results.map((r) => r.id), userId)).map((a) => [a.id, a]));
  return results.flatMap((r) => (albums.get(r.id) ? [{ album: albums.get(r.id)!, rated: r.rated, total: r.total, nextId: r.next_id }] : []));
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
     WHERE p.user_id = ?1 AND p.ms_played >= 30000
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
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.name, avg(s.quality_score) AS average, count(DISTINCT s.recording_id) AS tracks
     FROM v_recording_genre vg JOIN genre g ON g.id = vg.genre_id
     JOIN v_recording_score s ON s.recording_id = vg.recording_id AND s.user_id = ?1
     GROUP BY g.id HAVING tracks >= 3
     ORDER BY average DESC, tracks DESC LIMIT ?2`,
  )
    .bind(userId, limit)
    .all<LovedGenre>();
  return results;
}
