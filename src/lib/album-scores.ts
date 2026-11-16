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
import { byScores } from './library-cache';
import { rankAnchor } from './rank-anchor';

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
  /**
   * Rated for itself: a song of its own or the album as a whole. A single
   * whose song only borrows its album's score (inherited.ts) is not, and
   * ranks below every album that is (Runaway among the best singles, 16 Nov).
   */
  own: boolean;
}

export type AlbumScores = Record<string, ScoredAlbum>;

/**
 * How an album ranks: its score, pulled toward the ranking anchor (halfway
 * between 70 and the user's average album, rank-anchor.ts) by
 * how much of it is not rated yet. Every track rated, it ranks at its
 * score; one of twelve rated, mostly at the average, so a 97 with every
 * track rated outranks a 100 on one song. The square root lets a few
 * tracks count for a fair amount. An album rated only as a whole counts as
 * half rated. Scores shown are never changed; only the order. Pure.
 *
 * Then, for albums scored about the same, the more fully considered one
 * first: up to CONSIDERED points more for the share of its songs rated in
 * full rather than by gut. A fully considered 98 is more of a 98 than one
 * mostly by gut (I Didn't Mean To Haunt You, every song in full, 97.5;
 * Ants From Up There, two of ten, 97.9; 15 Nov). Never less: an album
 * rated by gut keeps its score and its place against everything not as
 * close.
 */
export const CONSIDERED = 1;

export function rankScore(score: number, rated: number, tracks: number | null, average: number, considered = 0): number {
  const share = rated === 0 ? 0.5 : !tracks || tracks <= 0 ? 1 : Math.min(1, rated / tracks);
  const anchor = rankAnchor(average);
  return anchor + (score - anchor) * Math.sqrt(share) + CONSIDERED * Math.max(0, Math.min(1, considered));
}

export async function albumScores(userId: string | null): Promise<AlbumScores> {
  if (!userId) return {};
  // (Not 'album-scores': standing.ts keeps its own list under that name.)
  // By the scores stamp, not the library's: an import changes no score.
  return byScores('album-score-map:v6', userId, async () => {
    const [{ results }, { results: detailed }] = await Promise.all([
      env.DB.prepare(
        `SELECT s.release_group_id AS id, s.quality_score AS quality, s.personal_score AS personal,
                s.rated_track_count AS rated, s.track_count AS tracks, g.type, g.first_release_date AS released
         FROM v_release_score s JOIN release_group g ON g.id = s.release_group_id
         WHERE s.user_id = ?1`,
      )
        .bind(userId)
        .all<Omit<ScoredAlbum, 'rank' | 'own'> & { id: string }>(),
      // Each album's songs rated for themselves, and how many in full (a detailed rating), and
      // albums rated as a whole: from the ratings outward, a few thousand rows, where the
      // canonical-edition view would be built whole (98,000).
      env.DB.prepare(
        `SELECT x.release_group_id AS id, count(DISTINCT r.entity_id) AS rated,
                count(DISTINCT CASE WHEN r.depth = 'detailed' THEN r.entity_id END) AS n
         FROM rating r JOIN track t ON t.recording_id = r.entity_id JOIN release x ON x.id = t.release_id
         WHERE r.user_id = ?1 AND r.entity_type = 'recording'
         GROUP BY x.release_group_id
         UNION ALL
         SELECT entity_id, 1, 0 FROM rating WHERE user_id = ?1 AND entity_type = 'release_group'`,
      )
        .bind(userId)
        .all<{ id: string; rated: number; n: number }>(),
    ]);
    const inFull = new Map<string, number>();
    const ownRated = new Set<string>();
    for (const d of detailed) {
      if (d.n) inFull.set(d.id, Math.max(inFull.get(d.id) ?? 0, d.n));
      if (d.rated) ownRated.add(d.id);
    }
    const average = results.length ? results.reduce((sum, r) => sum + r.quality, 0) / results.length : 0;
    return Object.fromEntries(
      results.map(({ id, ...score }) => {
        const considered = score.tracks ? (inFull.get(id) ?? 0) / score.tracks : 0;
        const own = ownRated.has(id);
        // Borrowed only: below everything rated for itself, in score order among its kind.
        const rank = rankScore(score.quality, score.rated, score.tracks, average, considered) - (own ? 0 : 1000);
        return [id, { ...score, rank, own }];
      }),
    );
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
): (T & { quality_score: number | null; personal_score: number | null; rank_score: number | null; completeness: Completeness | null })[] {
  return rows.map((row) => ({
    ...row,
    quality_score: scores[row.id]?.quality ?? null,
    personal_score: scores[row.id]?.personal ?? null,
    rank_score: scores[row.id]?.rank ?? null,
    completeness: completenessOf(scores[row.id]),
  }));
}

/** How much of an album is rated, for the mark beside its score (Score.astro). */
export interface Completeness {
  rated: number;
  of: number;
}

/** How much of an album is rated, or null when all of it is (or its length is unknown). */
export function completenessOf(score: ScoredAlbum | undefined): Completeness | null {
  if (!score || !score.tracks || score.rated >= score.tracks) return null;
  return { rated: score.rated, of: score.tracks };
}
