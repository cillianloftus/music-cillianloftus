/**
 * The front page's reading of the library: how big it is, what is rated
 * highest, and what was rated lately (with the impact notes, the part no
 * other source could supply). Scores come from the views as everywhere.
 */

import { env } from 'cloudflare:workers';
import { albumScores } from './album-scores';
import { byLibrary } from './library-cache';
import { artistLines, releaseGroupsByIds, type CreditPart, type ReleaseGroupSummary } from './catalogue';

export interface LibraryStats {
  albums: number;
  tracks: number;
  artists: number;
  ratings: number;
  ratedAlbums: number;
}

export async function libraryStats(userId: string | null): Promise<LibraryStats> {
  // The library's size moves with imports, not ratings: kept for no one.
  // Rated albums are the user's album scores. Together these read 45,000
  // rows on every home page after a rating.
  const [size, scores, ratings] = await Promise.all([
    byLibrary('library-size:v1', null, async () =>
      (await env.DB.prepare(
        `SELECT (SELECT count(*) FROM release_group) AS albums,
                (SELECT count(*) FROM recording) AS tracks,
                (SELECT count(DISTINCT c.artist_id) FROM artist_credit c WHERE c.role = 'primary') AS artists`,
      ).first<Pick<LibraryStats, 'albums' | 'tracks' | 'artists'>>()) ?? { albums: 0, tracks: 0, artists: 0 },
    ),
    albumScores(userId),
    env.DB.prepare(`SELECT count(*) AS n FROM rating WHERE user_id = ?1`).bind(userId).first<number>('n'),
  ]);
  return { ...size, ratings: ratings ?? 0, ratedAlbums: Object.keys(scores).length };
}

/** Albums by quality, best first; ties by personal score, then title. */
export async function topReleaseGroups(userId: string | null, limit = 10): Promise<ReleaseGroupSummary[]> {
  const ids = Object.entries(await albumScores(userId))
    .sort(([a, x], [b, y]) => y.quality - x.quality || y.personal - x.personal || a.localeCompare(b))
    .slice(0, limit)
    .map(([id]) => id);
  const albums = await releaseGroupsByIds(ids, userId);
  const byId = new Map(albums.map((a) => [a.id, a]));
  return ids.map((id) => byId.get(id)).filter((a): a is ReleaseGroupSummary => a !== undefined);
}

export interface RecentRating {
  entity_type: 'recording' | 'release_group';
  entity_id: string;
  title: string;
  album_id: string | null;
  album_title: string | null;
  art_key: string | null;
  rated_at: string;
  quality_score: number | null;
  personal_score: number | null;
  impact_note: string | null;
  credits: CreditPart[];
}

/** The latest rating of each of the most recently rated things. */
export async function recentRatings(userId: string | null, limit = 8): Promise<RecentRating[]> {
  if (!userId) return [];
  const { results } = await env.DB.prepare(
    `WITH latest AS (
       SELECT entity_type, entity_id, max(rated_at) AS rated_at
       FROM rating WHERE user_id = ?1
       GROUP BY entity_type, entity_id
       ORDER BY rated_at DESC LIMIT ?2
     )
     SELECT l.entity_type, l.entity_id, l.rated_at,
            coalesce(g.title, rec.title) AS title,
            coalesce(g.id, ra.release_group_id) AS album_id,
            coalesce(g.title, ag.title) AS album_title,
            coalesce(gr.art_key, fa.art_key, ar.art_key) AS art_key,
            rs.quality_score, rs.personal_score,
            (SELECT r.impact_note FROM rating r WHERE r.user_id = ?1 AND r.entity_type = l.entity_type
               AND r.entity_id = l.entity_id AND r.rated_at = l.rated_at) AS impact_note
     FROM latest l
     LEFT JOIN release_group g ON l.entity_type = 'release_group' AND g.id = l.entity_id
     LEFT JOIN v_release_group_canonical gc ON gc.release_group_id = g.id
     LEFT JOIN release gr ON gr.id = gc.release_id
     LEFT JOIN recording rec ON l.entity_type = 'recording' AND rec.id = l.entity_id
     LEFT JOIN v_recording_album ra ON ra.recording_id = rec.id
     LEFT JOIN release_group ag ON ag.id = ra.release_group_id
     LEFT JOIN v_release_group_canonical ac ON ac.release_group_id = ag.id
     LEFT JOIN release ar ON ar.id = ac.release_id
     LEFT JOIN v_recording_score rs ON rs.recording_id = rec.id AND rs.user_id = ?1
     LEFT JOIN v_recording_first_art fa ON fa.recording_id = rec.id
     ORDER BY l.rated_at DESC`,
  )
    .bind(userId, limit)
    .all<Omit<RecentRating, 'credits'>>();
  // Albums' scores from the user's album scores, not a join on v_release_score.
  const scores = await albumScores(userId);
  for (const r of results) {
    if (r.entity_type !== 'release_group') continue;
    r.quality_score = scores[r.entity_id]?.quality ?? null;
    r.personal_score = scores[r.entity_id]?.personal ?? null;
  }

  const [albumLines, trackLines] = await Promise.all([
    artistLines('release_group', results.filter((r) => r.entity_type === 'release_group').map((r) => r.entity_id)),
    artistLines('recording', results.filter((r) => r.entity_type === 'recording').map((r) => r.entity_id)),
  ]);
  return results.map((r) => ({
    ...r,
    credits: (r.entity_type === 'release_group' ? albumLines : trackLines).get(r.entity_id) ?? [],
  }));
}

/** When each rating in the last year was made (every rating, re-ratings too), for the diary's calendar. */
export async function ratingMoments(userId: string | null): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT rated_at FROM rating WHERE user_id = ?1 AND rated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-380 days')`,
  )
    .bind(userId)
    .all<{ rated_at: string }>();
  return results.map((r) => r.rated_at);
}

/** When each rating in one calendar year was made (Dublin dates are near enough to UTC at the year's ends to take a day either side). */
export async function ratingMomentsIn(userId: string | null, year: number): Promise<string[]> {
  const { results } = await env.DB.prepare(`SELECT rated_at FROM rating WHERE user_id = ?1 AND rated_at >= ?2 AND rated_at < ?3`)
    .bind(userId, `${year - 1}-12-31`, `${year + 1}-01-02`)
    .all<{ rated_at: string }>();
  return results.map((r) => r.rated_at);
}
