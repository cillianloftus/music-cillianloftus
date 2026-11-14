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

/** Arrangement and sound split production in two (migrations/0042); originality joined (0045). */
export const CRAFT_KEYS = ['arrangement', 'sound', 'songwriting', 'lyrics', 'performance', 'originality'] as const;
export const ALBUM_KEYS = ['sequencing', 'cohesion', 'ambition'] as const;
export type CraftKey = (typeof CRAFT_KEYS)[number];
export type AlbumKey = (typeof ALBUM_KEYS)[number];

export interface Weights {
  craft: Record<CraftKey, number>;
  album: Record<AlbumKey, number>;
  /**
   * interlude: how much an interlude counts beside a song (0–1).
   * length: how much a track's length sets its weight in its album (0–1).
   */
  release: { tracks: number; album_axes: number; trim_lowest: boolean; interlude: number; length: number };
}

/** The defaults the views fall back to for any missing key. */
export const DEFAULT_WEIGHTS: Weights = {
  craft: { arrangement: 0.5, sound: 0.5, songwriting: 1, lyrics: 1, performance: 1, originality: 1 },
  album: { sequencing: 1, cohesion: 1, ambition: 1 },
  release: { tracks: 0.7, album_axes: 0.3, trim_lowest: true, interlude: 0.5, length: 0 },
};

/** Song is the default and is never stored unless chosen. */
export type TrackKind = 'song' | 'interlude' | 'skit';

/**
 * One rating row: axes are null when not given. A row from before the
 * split has production instead, which stands in for arrangement and sound.
 */
export type AxisValues = Partial<Record<CraftKey | AlbumKey | 'production', number | null>>;
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
  /** Tracks that are not songs. Skits score nothing; interludes count less. */
  kinds?: Record<string, TrackKind>;
  /** Track lengths in milliseconds, where known. */
  lengths?: Record<string, number>;
}

/**
 * An album's odd songs out are left out of its score (migration 0065): a
 * song OUTLIER_GAP points or more from the album's middle song (the median),
 * high or low, when the songs that far out on its side are less than
 * TRIM_MAX_SHARE of the songs rated (of their running time, or, a length
 * unknown, of their number). More than that, and they are what the album
 * is like.
 */
export const TRIM_MAX_SHARE = 0.15;
export const OUTLIER_GAP = 20;

/** Whether songs this long (lengths, or undefined where unknown) are a small enough part of the album to leave out. Pure. */
export function smallPart(lengths: (number | undefined)[], runtime: { ms: number | null; tracks: number } | undefined): boolean {
  if (!runtime) return false;
  if (lengths.every((l) => l !== undefined)) {
    const ms = lengths.reduce<number>((sum, l) => sum + l!, 0);
    return runtime.ms !== null && ms < TRIM_MAX_SHARE * runtime.ms;
  }
  return lengths.length < TRIM_MAX_SHARE * runtime.tracks;
}

const medianOf = (sorted: number[]): number => {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
};

/**
 * The songs left out of an album's score as outliers: ids. Each side (low,
 * high) is judged on its own. Pure.
 */
export function outliers(rated: { id: string; q: number; length?: number }[]): Set<string> {
  const left = new Set<string>();
  if (rated.length === 0) return left;
  // The songs rated are the whole the share is of.
  const runtime = {
    ms: rated.every((r) => r.length !== undefined) ? rated.reduce((sum, r) => sum + r.length!, 0) : null,
    tracks: rated.length,
  };
  const median = medianOf(rated.map((r) => r.q).sort((a, b) => a - b));
  const low = rated.filter((r) => r.q <= median - OUTLIER_GAP);
  const high = rated.filter((r) => r.q >= median + OUTLIER_GAP);
  for (const side of [low, high]) {
    if (side.length > 0 && smallPart(side.map((r) => r.length), runtime)) for (const r of side) left.add(r.id);
  }
  return left;
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
    const value = key === 'arrangement' || key === 'sound' ? (values[key] ?? values.production) : values[key];
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

  const kinds = inputs.kinds ?? {};
  const lengths = inputs.lengths ?? {};

  // v_recording_score: a skit has no score.
  const recordings = new Map<string, Score>();
  for (const [id, r] of Object.entries(inputs.recordings)) {
    if (kinds[id] === 'skit') continue;
    const score = recordingScore(r, w, offset);
    if (score) recordings.set(id, score);
  }

  // v_release_score: albums with a rated canonical track, an album rating, or both.
  const albums = new Map<string, AlbumScore>();
  const ids = new Set([...Object.keys(inputs.albums), ...Object.keys(inputs.canonical)]);
  for (const id of ids) {
    const rated = [...new Set(inputs.canonical[id] ?? [])]
      .filter((recording) => recordings.has(recording))
      .map((recording) => ({ id: recording, q: recordings.get(recording)!.quality, length: lengths[recording] }));
    const qualities = rated.map((r) => r.q);

    // A weighted mean: an interlude counts less, and with length switched
    // on a track counts by its length over the album's mean length.
    let tracks: number | null = null;
    if (rated.length > 0) {
      const known = rated.filter((r) => r.length !== undefined);
      const mean = known.length > 0 ? known.reduce((a, r) => a + r.length!, 0) / known.length : null;
      const left = w.release.trim_lowest ? outliers(rated) : new Set<string>();
      const kept = rated.filter((r) => !left.has(r.id));
      let total = 0;
      let weight = 0;
      for (const r of kept) {
        const kind = kinds[r.id] === 'interlude' ? w.release.interlude : 1;
        const byLength = r.length === undefined || mean === null ? 1 : 1 - w.release.length + (w.release.length * r.length) / mean;
        total += kind * byLength * r.q;
        weight += kind * byLength;
      }
      tracks = weight > 0 ? total / weight : null;
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
