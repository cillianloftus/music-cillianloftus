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

export interface ScoredAlbum {
  quality: number;
  personal: number;
  rated: number;
  tracks: number | null;
  type: string;
  /** The album's first release date, as stored (any precision). */
  released: string | null;
  /** What albums are ranked by (rankScore): the score, as sure as its rating is complete. */
  rank: number;
}

export type AlbumScores = Record<string, ScoredAlbum>;

/**
 * How an album ranks: its score, pulled toward the user's average album by
 * how much of it is not rated yet. Every track rated, it ranks at its
 * score; one of twelve rated, mostly at the average, so a 97 with every
 * track rated outranks a 100 on one song. The square root lets a few
 * tracks count for a fair amount. An album rated only as a whole counts as
 * half rated. Scores shown are never changed; only the order. Pure.
 */
export function rankScore(score: number, rated: number, tracks: number | null, average: number): number {
  const share = rated === 0 ? 0.5 : !tracks || tracks <= 0 ? 1 : Math.min(1, rated / tracks);
  return average + (score - average) * Math.sqrt(share);
}

export async function albumScores(userId: string | null): Promise<AlbumScores> {
  if (!userId) return {};
  // (Not 'album-scores': standing.ts keeps its own list under that name.)
  return byLibrary('album-score-map:v3', userId, async () => {
    const { results } = await env.DB.prepare(
      `SELECT s.release_group_id AS id, s.quality_score AS quality, s.personal_score AS personal,
              s.rated_track_count AS rated, s.track_count AS tracks, g.type, g.first_release_date AS released
       FROM v_release_score s JOIN release_group g ON g.id = s.release_group_id
       WHERE s.user_id = ?1`,
    )
      .bind(userId)
      .all<Omit<ScoredAlbum, 'rank'> & { id: string }>();
    const average = results.length ? results.reduce((sum, r) => sum + r.quality, 0) / results.length : 0;
    return Object.fromEntries(results.map(({ id, ...score }) => [id, { ...score, rank: rankScore(score.quality, score.rated, score.tracks, average) }]));
  });
}

/** Best first by rank (ties by score, then id, so the order is stable). */
export function byRank(scores: AlbumScores): (a: string, b: string) => number {
  return (a, b) => {
    const x = scores[a];
    const y = scores[b];
    if (!x || !y) return (x ? 0 : 1) - (y ? 0 : 1);
    return y.rank - x.rank || y.quality - x.quality || (a < b ? -1 : a > b ? 1 : 0);
  };
}

/** Rows given their scores from the map, as the view's LEFT JOIN gave them. */
export function withScores<T extends { id: string }>(
  rows: T[],
  scores: AlbumScores,
): (T & { quality_score: number | null; personal_score: number | null; rank_score: number | null })[] {
  return rows.map((row) => ({
    ...row,
    quality_score: scores[row.id]?.quality ?? null,
    personal_score: scores[row.id]?.personal ?? null,
    rank_score: scores[row.id]?.rank ?? null,
  }));
}
