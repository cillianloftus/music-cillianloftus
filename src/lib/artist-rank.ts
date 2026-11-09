/**
 * How artists rank: their average track score, as sure as the number of
 * ratings behind it makes it. The average is pulled toward the ranking
 * anchor (halfway between 70 and the user's overall track average,
 * rank-anchor.ts), less the more tracks are rated, on a log curve
 * that reaches the full average at SURE_AT ratings and stays there. So 50
 * ratings averaging 85 outrank 5 averaging 88, but a big discography is
 * not rewarded for its size: past about an album's worth, an artist ranks
 * at their own average, and three consistently great albums rank as high
 * as thirty. The average shown is never adjusted; only the order.
 */

import { rankAnchor } from './rank-anchor';

/** Ratings past which more make no difference: about one album. */
export const SURE_AT = 12;

/** How much an average of this many ratings counts, 0 to 1. Pure. */
export function sureness(rated: number): number {
  if (rated <= 0) return 0;
  return Math.min(1, Math.log1p(rated) / Math.log1p(SURE_AT));
}

/** What an artist ranks by. Pure. */
export function artistRank(average: number, rated: number, mean: number): number {
  // Pulled toward halfway between 70 and the user's average (rank-anchor.ts).
  const anchor = rankAnchor(mean);
  return anchor + (average - anchor) * sureness(rated);
}
