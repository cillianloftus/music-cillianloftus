/**
 * Data for the track and genre pages. Scores come from the views; genres
 * from the same tag rules as everywhere (manual tags win; a track without
 * its own inherits its album's).
 */

import { env } from 'cloudflare:workers';
import { artistLines, releaseGroupsByIds, type CreditPart, type ReleaseGroupSummary } from './catalogue';
import type { CreditRole } from './import/plan';

export interface TrackDetail {
  id: string;
  title: string;
  length_ms: number | null;
  isrc: string | null;
  spotify_id: string | null;
  genius_url: string | null;
  mbid: string | null;
  work_id: string | null;
  work_title: string | null;
  quality_score: number | null;
  personal_score: number | null;
  depth: 'gut' | 'detailed' | null;
  credits: CreditPart[];
}

export async function trackDetail(id: string, viewerId: string | null): Promise<TrackDetail | null> {
  const row = await env.DB.prepare(
    `SELECT r.id, r.title, r.length_ms, r.isrc, r.spotify_id, r.work_id, w.title AS work_title, r.genius_url, r.mbid,
            s.quality_score, s.personal_score, s.depth
     FROM recording r
     LEFT JOIN work w ON w.id = r.work_id
     LEFT JOIN v_recording_score s ON s.recording_id = r.id AND s.user_id = ?2
     WHERE r.id = ?1`,
  )
    .bind(id, viewerId)
    .first<Omit<TrackDetail, 'credits'>>();
  if (!row) return null;
  const lines = await artistLines('recording', [id]);
  return { ...row, credits: lines.get(id) ?? [] };
}

export interface Appearance {
  album: ReleaseGroupSummary;
  /** Where it sits on that album's standard edition, if it is on it. */
  position: number | null;
  disc: number | null;
  standard: boolean;
}

/** Every release the recording is on, earliest first. */
export async function trackAppearances(id: string, viewerId: string | null): Promise<Appearance[]> {
  const { results } = await env.DB.prepare(
    `SELECT x.release_group_id AS album_id,
            max(x.id = c.release_id) AS standard,
            min(CASE WHEN x.id = c.release_id THEN t.position END) AS position,
            min(CASE WHEN x.id = c.release_id THEN t.disc END) AS disc
     FROM track t
     JOIN release x ON x.id = t.release_id
     JOIN v_release_group_canonical c ON c.release_group_id = x.release_group_id
     JOIN release_group g ON g.id = x.release_group_id
     WHERE t.recording_id = ?
     GROUP BY x.release_group_id
     -- In the order they came out: the first release first.
     ORDER BY g.first_release_date IS NULL, substr(g.first_release_date || '-99-99', 1, 10), g.type <> 'album', g.title`,
  )
    .bind(id)
    .all<{ album_id: string; standard: number; position: number | null; disc: number | null }>();
  const albums = new Map((await releaseGroupsByIds(results.map((r) => r.album_id), viewerId)).map((a) => [a.id, a]));
  return results.flatMap((r) => {
    const album = albums.get(r.album_id);
    return album ? [{ album, position: r.position, disc: r.disc, standard: r.standard === 1 }] : [];
  });
}

export interface TrackCredit {
  artist_id: string;
  name: string;
  role: CreditRole;
  role_label: string;
  family: string;
  key_order: number | null;
}

/** Everyone credited on the recording beyond its artist line, in role order. */
export async function trackCredits(id: string): Promise<TrackCredit[]> {
  const { results } = await env.DB.prepare(
    `SELECT a.id AS artist_id, a.name, c.role, r.label AS role_label, r.family, r.key_order
     FROM artist_credit c JOIN artist a ON a.id = c.artist_id JOIN credit_role r ON r.id = c.role
     WHERE c.entity_type = 'recording' AND c.entity_id = ? AND c.role NOT IN ('primary', 'featured')
     ORDER BY r.key_order IS NULL, r.key_order, r.position, r.label, c.position, a.sort_name`,
  )
    .bind(id)
    .all<TrackCredit>();
  return results;
}

export interface Version {
  id: string;
  title: string;
  album_id: string | null;
  album_title: string | null;
  art_key: string | null;
  quality_score: number | null;
  personal_score: number | null;
  credits: CreditPart[];
}

/** Other recordings of the same song (the same work): covers, live takes, remixes. */
export async function otherVersions(id: string, workId: string | null, viewerId: string | null): Promise<Version[]> {
  if (!workId) return [];
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.title, ra.release_group_id AS album_id, g.title AS album_title, coalesce(fa.art_key, x.art_key) AS art_key,
            s.quality_score, s.personal_score
     FROM recording r
     LEFT JOIN v_recording_first_art fa ON fa.recording_id = r.id
     LEFT JOIN v_recording_album ra ON ra.recording_id = r.id
     LEFT JOIN release_group g ON g.id = ra.release_group_id
     LEFT JOIN v_release_group_canonical gc ON gc.release_group_id = g.id
     LEFT JOIN release x ON x.id = gc.release_id
     LEFT JOIN v_recording_score s ON s.recording_id = r.id AND s.user_id = ?3
     WHERE r.work_id = ?2 AND r.id <> ?1
     ORDER BY s.personal_score IS NULL, s.personal_score DESC, r.title`,
  )
    .bind(id, workId, viewerId)
    .all<Omit<Version, 'credits'>>();
  const lines = await artistLines('recording', results.map((r) => r.id));
  return results.map((r) => ({ ...r, credits: lines.get(r.id) ?? [] }));
}

export interface GenreDetail {
  id: string;
  name: string;
  /** Along primary parents, root first. */
  ancestors: { id: string; name: string }[];
  /** Every parent, the primary one first. */
  parents: { id: string; name: string; primary: boolean }[];
  children: { id: string; name: string; tracks: number }[];
  /** Tracks tagged with this genre itself, or with anything beneath it too when deep. */
  tracks: number;
  albums: number;
  /** The same, always counting everything beneath it. */
  tracksBeneath: number;
  /** Tagged with this genre itself, not one beneath it. */
  tracksDirect: number;
}

/**
 * The genre and, when deep, everything beneath it. A genre on its own is
 * what was tagged with it: an art pop song is not thereby a pop song.
 */
const treeOf = (deep: boolean) =>
  deep
    ? `WITH RECURSIVE tree(id) AS (SELECT ?1 UNION SELECT e.genre_id FROM v_genre_edge e JOIN tree ON e.parent_id = tree.id)`
    : `WITH tree(id) AS (SELECT ?1)`;

export async function genreDetail(id: string, deep = false): Promise<GenreDetail | null> {
  const genre = await env.DB.prepare(`SELECT id, name FROM genre WHERE id = ?`).bind(id).first<{ id: string; name: string }>();
  if (!genre) return null;
  const [ancestors, children, counts, parents] = await env.DB.batch([
    env.DB.prepare(
      `WITH RECURSIVE up(id, name, parent_id, depth) AS (
         SELECT g.id, g.name, g.parent_id, 0 FROM genre g WHERE g.id = (SELECT parent_id FROM genre WHERE id = ?1)
         UNION ALL
         SELECT g.id, g.name, g.parent_id, up.depth + 1 FROM genre g JOIN up ON g.id = up.parent_id
       )
       SELECT id, name FROM up ORDER BY depth DESC`,
    ).bind(id),
    env.DB.prepare(
      `SELECT g.id, g.name, (SELECT count(DISTINCT vg.recording_id) FROM v_recording_genre vg WHERE vg.genre_id = g.id) AS tracks
       FROM v_genre_edge e JOIN genre g ON g.id = e.genre_id WHERE e.parent_id = ? ORDER BY tracks DESC, g.name`,
    ).bind(id),
    env.DB.prepare(
      `${treeOf(deep)}
       SELECT (SELECT count(DISTINCT recording_id) FROM v_recording_genre WHERE genre_id IN (SELECT id FROM tree)) AS tracks,
              (SELECT count(DISTINCT release_group_id) FROM v_release_group_genre WHERE genre_id IN (SELECT id FROM tree)) AS albums,
              (WITH RECURSIVE below(id) AS (SELECT ?1 UNION SELECT e.genre_id FROM v_genre_edge e JOIN below ON e.parent_id = below.id)
               SELECT count(DISTINCT recording_id) FROM v_recording_genre WHERE genre_id IN (SELECT id FROM below)) AS tracksBeneath,
              (SELECT count(DISTINCT recording_id) FROM v_recording_genre WHERE genre_id = ?1) AS tracksDirect`,
    ).bind(id),
    env.DB.prepare(
      `SELECT g.id, g.name, e.is_primary AS "primary" FROM v_genre_edge e JOIN genre g ON g.id = e.parent_id
       WHERE e.genre_id = ? ORDER BY e.is_primary DESC, g.name`,
    ).bind(id),
  ]);
  const count = (counts!.results[0] ?? { tracks: 0, albums: 0, tracksBeneath: 0, tracksDirect: 0 }) as {
    tracks: number;
    albums: number;
    tracksBeneath: number;
    tracksDirect: number;
  };
  return {
    ...genre,
    ancestors: ancestors!.results as { id: string; name: string }[],
    children: children!.results as GenreDetail['children'],
    parents: (parents!.results as { id: string; name: string; primary: number }[]).map((p) => ({ ...p, primary: p.primary === 1 })),
    tracks: count.tracks,
    albums: count.albums,
    tracksBeneath: count.tracksBeneath,
    tracksDirect: count.tracksDirect,
  };
}

/** Albums in the genre (or beneath it, when deep): rated ones by score first, then the rest by date. */
export async function genreAlbums(id: string, viewerId: string | null, limit = 24, deep = false): Promise<ReleaseGroupSummary[]> {
  const { results } = await env.DB.prepare(
    `${treeOf(deep)}
     SELECT DISTINCT vg.release_group_id AS id, s.personal_score, g.first_release_date
     FROM v_release_group_genre vg
     JOIN release_group g ON g.id = vg.release_group_id
     LEFT JOIN v_release_score s ON s.release_group_id = g.id AND s.user_id = ?2
     WHERE vg.genre_id IN (SELECT id FROM tree)
     ORDER BY s.personal_score IS NULL, s.personal_score DESC, g.first_release_date DESC
     LIMIT ?3`,
  )
    .bind(id, viewerId, limit)
    .all<{ id: string }>();
  const ids = results.map((r) => r.id);
  const byId = new Map((await releaseGroupsByIds(ids, viewerId)).map((a) => [a.id, a]));
  return ids.map((i) => byId.get(i)).filter((a): a is ReleaseGroupSummary => a !== undefined);
}

/** The best-rated tracks in the genre (or beneath it, when deep). */
export async function genreTopTracks(id: string, viewerId: string | null, limit = 10, deep = false): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `${treeOf(deep)}
     SELECT DISTINCT vg.recording_id AS id, s.personal_score
     FROM v_recording_genre vg
     JOIN v_recording_score s ON s.recording_id = vg.recording_id AND s.user_id = ?2
     WHERE vg.genre_id IN (SELECT id FROM tree)
     ORDER BY s.personal_score DESC
     LIMIT ?3`,
  )
    .bind(id, viewerId, limit)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/**
 * Albums in the library most like this one: shared genres (by weight),
 * and the same main artist counting for more. For "More like this".
 */
export async function similarAlbums(id: string, viewerId: string | null, limit = 8): Promise<ReleaseGroupSummary[]> {
  const { results } = await env.DB.prepare(
    `WITH mine AS (SELECT genre_id, weight FROM v_release_group_genre WHERE release_group_id = ?1),
     artists AS (SELECT artist_id FROM artist_credit WHERE entity_type = 'release_group' AND entity_id = ?1 AND role = 'primary'),
     scored AS (
       SELECT vg.release_group_id AS id, sum(min(vg.weight, m.weight)) AS genre_score
       FROM v_release_group_genre vg JOIN mine m ON m.genre_id = vg.genre_id
       WHERE vg.release_group_id <> ?1
       GROUP BY vg.release_group_id
       UNION ALL
       SELECT c.entity_id, 0 FROM artist_credit c
       WHERE c.entity_type = 'release_group' AND c.role = 'primary' AND c.entity_id <> ?1
         AND c.artist_id IN (SELECT artist_id FROM artists)
     )
     SELECT s.id,
            sum(s.genre_score) + 1.5 * EXISTS (
              SELECT 1 FROM artist_credit c WHERE c.entity_type = 'release_group' AND c.entity_id = s.id
                AND c.role = 'primary' AND c.artist_id IN (SELECT artist_id FROM artists)) AS score
     FROM scored s
     GROUP BY s.id
     ORDER BY score DESC, s.id
     LIMIT ?2`,
  )
    .bind(id, limit)
    .all<{ id: string; score: number }>();
  const ids = results.filter((r) => r.score > 0).map((r) => r.id);
  const byId = new Map((await releaseGroupsByIds(ids, viewerId)).map((a) => [a.id, a]));
  return ids.map((i) => byId.get(i)).filter((a): a is ReleaseGroupSummary => a !== undefined);
}
