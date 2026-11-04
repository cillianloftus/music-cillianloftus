/**
 * The score formula from migrations/0003, in TypeScript, for one job only:
 * previewing a set of weights before it is saved. SQL views cannot take
 * parameters, and the weights page has to re-rank the library on every
 * slider movement without a round trip.
 *
 * The views stay the source of truth. Everything shown elsewhere on the
 * site comes from them, and scoring.test.ts checks this module against
 * them for random ratings and weights, so the two cannot drift apart
 * unnoticed.
 *
 * No imports: this file is bundled into the browser as well.
 */

export const CRAFT_KEYS = ['production', 'songwriting', 'lyrics', 'performance'] as const;
export const ALBUM_KEYS = ['sequencing', 'cohesion', 'ambition'] as const;
export type CraftKey = (typeof CRAFT_KEYS)[number];
export type AlbumKey = (typeof ALBUM_KEYS)[number];

export interface Weights {
  craft: Record<CraftKey, number>;
  album: Record<AlbumKey, number>;
  release: { tracks: number; album_axes: number; trim_lowest: boolean };
}

/** The defaults the views fall back to for any missing key. */
export const DEFAULT_WEIGHTS: Weights = {
  craft: { production: 1, songwriting: 1, lyrics: 1, performance: 1 },
  album: { sequencing: 1, cohesion: 1, ambition: 1 },
  release: { tracks: 0.7, album_axes: 0.3, trim_lowest: true },
};

/** One rating row: axes are null when not given. */
export type AxisValues = Partial<Record<CraftKey | AlbumKey, number | null>>;
export interface RatingSample extends AxisValues {
  gut: number | null;
  impact: number | null;
}

export interface ScoreInputs {
  /** Every recording rating ever made with a gut score: calibration uses all history. */
  calibration: RatingSample[];
  /** Latest rating per recording. */
  recordings: Record<string, RatingSample>;
  /** Latest album rating per release group. */
  albums: Record<string, RatingSample>;
  /** Recordings on each album's canonical edition. */
  canonical: Record<string, string[]>;
}

export interface Score {
  quality: number;
  personal: number;
}

export interface AlbumScore extends Score {
  ratedTracks: number;
}

function weightedMean<K extends CraftKey | AlbumKey>(values: AxisValues, keys: readonly K[], weights: Record<K, number>): number | null {
  let total = 0;
  let weight = 0;
  for (const key of keys) {
    const value = values[key];
    if (value == null) continue;
    total += weights[key] * value;
    weight += weights[key];
  }
  return weight === 0 ? null : total / weight;
}

export const craftComposite = (r: AxisValues, w: Weights) => weightedMean(r, CRAFT_KEYS, w.craft);
export const albumComposite = (r: AxisValues, w: Weights) => weightedMean(r, ALBUM_KEYS, w.album);

const clamp = (n: number) => Math.max(0, Math.min(100, n));

/** v_gut_calibration: mean of (craft composite − gut) over rows with both. */
export function gutOffset(inputs: ScoreInputs, w: Weights): { offset: number; samples: number } {
  let total = 0;
  let samples = 0;
  for (const r of inputs.calibration) {
    const craft = craftComposite(r, w);
    if (r.gut == null || craft == null) continue;
    total += craft - r.gut;
    samples += 1;
  }
  return { offset: samples === 0 ? 0 : total / samples, samples };
}

/** v_recording_score. Null only for a row with neither axes nor gut. */
function recordingScore(r: RatingSample, w: Weights, offset: number): Score | null {
  const base = craftComposite(r, w) ?? (r.gut == null ? null : r.gut + offset);
  if (base == null) return null;
  const quality = clamp(10 * base);
  return { quality, personal: quality + (r.impact ?? 0) };
}

export interface Scores {
  offset: number;
  samples: number;
  recordings: Map<string, Score>;
  albums: Map<string, AlbumScore>;
}

/** Every recording and album score under the given weights. */
export function computeScores(inputs: ScoreInputs, w: Weights): Scores {
  const { offset, samples } = gutOffset(inputs, w);

  const recordings = new Map<string, Score>();
  for (const [id, r] of Object.entries(inputs.recordings)) {
    const score = recordingScore(r, w, offset);
    if (score) recordings.set(id, score);
  }

  // v_release_score: albums with a rated canonical track, an album rating, or both.
  const albums = new Map<string, AlbumScore>();
  const ids = new Set([...Object.keys(inputs.albums), ...Object.keys(inputs.canonical)]);
  for (const id of ids) {
    const qualities = (inputs.canonical[id] ?? [])
      .map((recording) => recordings.get(recording)?.quality)
      .filter((q): q is number => q !== undefined);

    let tracks: number | null = null;
    if (qualities.length > 0) {
      const total = qualities.reduce((a, b) => a + b, 0);
      tracks =
        qualities.length >= 2 && w.release.trim_lowest
          ? (total - Math.min(...qualities)) / (qualities.length - 1)
          : total / qualities.length;
    }

    const rating = inputs.albums[id];
    let album: number | null = null;
    if (rating) {
      const base = albumComposite(rating, w) ?? (rating.gut == null ? null : rating.gut + offset);
      album = base == null ? null : 10 * base;
    }

    if (tracks == null && album == null && !rating) continue;
    const blended =
      tracks != null && album != null
        ? (w.release.tracks * tracks + w.release.album_axes * album) / (w.release.tracks + w.release.album_axes)
        : (tracks ?? album);
    if (blended == null) continue;
    const quality = clamp(blended);
    albums.set(id, { quality, personal: quality + (rating?.impact ?? 0), ratedTracks: qualities.length });
  }

  return { offset, samples, recordings, albums };
}

/** Ids ordered best first, ties broken by id so the order is stable. */
export function rank<T extends Score>(scores: Map<string, T>, by: 'quality' | 'personal'): string[] {
  return [...scores.entries()]
    .sort(([a, x], [b, y]) => y[by] - x[by] || (a < b ? -1 : a > b ? 1 : 0))
    .map(([id]) => id);
}
