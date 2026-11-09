/**
 * What an uncertain score is pulled toward when ranking (album-scores.ts,
 * artist-rank.ts): halfway between 70 and the user's own average. 70 is
 * where a score means "genuinely enjoy", so a little-rated album or artist
 * is assumed to be enjoyable rather than as good as everything rated so
 * far; the average keeps it in step with how the user actually rates, as
 * that settles.
 */
export const ENJOY = 70;

export function rankAnchor(average: number | null): number {
  return average === null || !Number.isFinite(average) ? ENJOY : (ENJOY + average) / 2;
}
