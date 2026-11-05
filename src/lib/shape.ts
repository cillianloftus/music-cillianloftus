/**
 * An album's shape: how its scores run from first track to last. Split into
 * thirds by running order and compared, so the page can say an album is
 * front-loaded, finishes strong, peaks or sags in the middle, or holds
 * level, and say nothing when the difference is within the noise.
 */

export type ShapeVerdict = 'front' | 'back' | 'peak' | 'sag' | 'even';

export interface AlbumShape {
  /** Mean of the rated tracks in each third, in order; null where none are rated. */
  thirds: [number | null, number | null, number | null];
  verdict: ShapeVerdict;
  /** The words for it, with the numbers that back it; null for an even album. */
  words: string | null;
}

/** Points between thirds below which an album counts as level. */
export const SHAPE_MARGIN = 5;

/** Enough to have a shape: at least six tracks, two-thirds of them rated, some in every third. */
export function hasShape(scores: (number | null)[]): boolean {
  if (scores.length < 6) return false;
  const rated = scores.filter((s) => s !== null).length;
  return rated / scores.length >= 2 / 3 && shapeOf(scores).thirds.every((t) => t !== null);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function shapeOf(scores: (number | null)[]): AlbumShape {
  const n = scores.length;
  // Thirds by position; a remainder goes to the middle, so the ends are equal.
  const cut1 = Math.floor(n / 3);
  const cut2 = n - cut1;
  const part = (from: number, to: number) => mean(scores.slice(from, to).filter((s): s is number => s !== null));
  const thirds: AlbumShape['thirds'] = [part(0, cut1), part(cut1, cut2), part(cut2, n)];
  const [a, b, c] = thirds;
  if (a === null || b === null || c === null) return { thirds, verdict: 'even', words: null };

  const r = (x: number) => Math.round(x);
  const m = SHAPE_MARGIN;
  let verdict: ShapeVerdict = 'even';
  if (b - Math.max(a, c) >= m) verdict = 'peak';
  else if (Math.min(a, c) - b >= m) verdict = 'sag';
  else if (a - c >= m) verdict = 'front';
  else if (c - a >= m) verdict = 'back';

  const words: Record<ShapeVerdict, string | null> = {
    front: `Strongest at the start: the first third averages ${r(a)}, the last ${r(c)}.`,
    back: `Finishes strongest: the last third averages ${r(c)}, the first ${r(a)}.`,
    peak: `Peaks in the middle: ${r(b)} there, against ${r(a)} and ${r(c)} either side.`,
    sag: `Sags in the middle: ${r(b)} there, against ${r(a)} and ${r(c)} either side.`,
    even: null,
  };
  return { thirds, verdict, words: words[verdict] };
}
