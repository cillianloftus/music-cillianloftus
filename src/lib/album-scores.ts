/**
 * Every album score of one user, worked out once per state of the library
 * and kept (byLibrary). v_release_score has to be built whole however few
 * albums a query asks about (about 15,000 rows on production), and a page
 * of album shelves joined it a dozen times: the home page read 200,000
 * rows of album scores to show a few dozen. Now a page reads them from
 * here, and the view is built once after each rating (or weighting, or
 * track kind; the stamp moves with all three, migration 0051).
 */

import { env } from 'cloudflare:workers';
import { byLibrary } from './library-cache';

export interface AlbumScore {
  quality: number;
  personal: number;
  rated: number;
  tracks: number | null;
  type: string;
}

export type AlbumScores = Record<string, AlbumScore>;

export async function albumScores(userId: string | null): Promise<AlbumScores> {
  if (!userId) return {};
  // (Not 'album-scores': standing.ts keeps its own list under that name.)
  return byLibrary('album-score-map:v1', userId, async () => {
    const { results } = await env.DB.prepare(
      `SELECT s.release_group_id AS id, s.quality_score AS quality, s.personal_score AS personal,
              s.rated_track_count AS rated, s.track_count AS tracks, g.type
       FROM v_release_score s JOIN release_group g ON g.id = s.release_group_id
       WHERE s.user_id = ?1`,
    )
      .bind(userId)
      .all<AlbumScore & { id: string }>();
    return Object.fromEntries(results.map(({ id, ...score }) => [id, score]));
  });
}

/** Rows given their scores from the map, as the view's LEFT JOIN gave them. */
export function withScores<T extends { id: string }>(
  rows: T[],
  scores: AlbumScores,
): (T & { quality_score: number | null; personal_score: number | null })[] {
  return rows.map((row) => ({
    ...row,
    quality_score: scores[row.id]?.quality ?? null,
    personal_score: scores[row.id]?.personal ?? null,
  }));
}
