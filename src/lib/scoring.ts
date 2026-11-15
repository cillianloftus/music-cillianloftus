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
   * trim_lowest: whether an album's odd songs out are left out (the name is from when it was the lowest track).
   * outlier_gap: how many points from the album's middle song make a song an odd one out.
   * harshness: how much more a weak song (under WEAK_BELOW) counts in its album, per 30 points under (0073).
   */
  release: { tracks: number; album_axes: number; trim_lowest: boolean; outlier_gap: number; interlude: number; length: number; harshness: number };
  /**
   * evidence: how many songs rated both ways a gut level, an artist or a
   * genre needs before its own gap counts half (src/lib/scoring.ts, calibrate).
   */
  calibration: { evidence: number };
}

/** The defaults the views fall back to for any missing key. */
export const DEFAULT_WEIGHTS: Weights = {
  craft: { arrangement: 0.5, sound: 0.5, songwriting: 1, lyrics: 1, performance: 1, originality: 1 },
  album: { sequencing: 1, cohesion: 1, ambition: 1 },
  release: { tracks: 0.7, album_axes: 0.3, trim_lowest: true, outlier_gap: 20, interlude: 0.5, length: 0, harshness: 2 },
  calibration: { evidence: 5 },
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
  /** Each rated recording's first primary artist. */
  artists?: Record<string, string>;
  /** Each rated recording's genres, as v_recording_genre has them. */
  genres?: Record<string, string[]>;
  /** Latest rating per recording (ties by id): its score, and its pair for the gut calibration. */
  recordings: Record<string, RatingSample>;
  /** Latest album rating per release group. */
  albums: Record<string, RatingSample>;
  /** Recordings on each album's canonical edition. */
  canonical: Record<string, string[]>;
  /** Tracks that are not songs. Skits score nothing; interludes count less. */
  kinds?: Record<string, TrackKind>;
  /** Track lengths in milliseconds, where known. */
  lengths?: Record<string, number>;
  /**
   * Unrated versions of a rated song, each with the version it borrows its
   * score from (inherited_score, 0075). Its score is that one's, under the
   * weights given, so the preview moves both together.
   */
  inherits?: Record<string, string>;
}

/**
 * An album's odd songs out are left out of its score (migrations 0065, 0066):
 * a song the gap (release.outlier_gap, OUTLIER_GAP unless set) or more
 * points from the album's middle song (the median),
 * high or low, when the songs that far out on its side are less than
 * TRIM_MAX_SHARE of the songs rated (of their running time, or, a length
 * unknown, of their number). More than that, and they are what the album
 * is like.
 */
export const TRIM_MAX_SHARE = 0.15;
export const OUTLIER_GAP = 20;

/**
 * Below this a song is weak, and counts for more in its album the further
 * below it is: 1 + harshness × (70 − score) / 30, so at the default 2 a 40
 * counts three times, a 10 five times. A bad album's few decent songs
 * carried it (Confessions of a Dangerous Mind, 7 of 16 songs under 60, at
 * 55); a good album has no weak songs, so it does not move. 0073.
 */
export const WEAK_BELOW = 70;

export function weakWeight(q: number, harshness: number): number {
  return 1 + (harshness * Math.max(0, WEAK_BELOW - q)) / 30;
}

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
export function outliers(rated: { id: string; q: number; length?: number }[], gap = OUTLIER_GAP): Set<string> {
  const left = new Set<string>();
  if (rated.length === 0) return left;
  // The songs rated are the whole the share is of.
  const runtime = {
    ms: rated.every((r) => r.length !== undefined) ? rated.reduce((sum, r) => sum + r.length!, 0) : null,
    tracks: rated.length,
  };
  const median = medianOf(rated.map((r) => r.q).sort((a, b) => a - b));
  const low = rated.filter((r) => r.q <= median - gap);
  const high = rated.filter((r) => r.q >= median + gap);
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

/**
 * A gut and a detailed score further apart than this are a slip, not a
 * habit: a slider touched on the way past and caught by the autosave
 * (Bread Song, 14 Nov: gut 10, detailed 0, which took two points off every
 * Black Country, New Road gut 10). Left out of the calibration.
 */
export const MAX_PAIR_GAP = 3;

/**
 * Each song's pair of gut and detailed score: its current rating, when that
 * has both and they are within MAX_PAIR_GAP. An older row is never used: a
 * rating given again by gut alone has taken its detail back.
 */
function pairsOf(inputs: ScoreInputs, w: Weights): Map<string, { gut: number; craft: number }> {
  const pairs = new Map<string, { gut: number; craft: number }>();
  for (const [id, r] of Object.entries(inputs.recordings)) {
    const craft = craftComposite(r, w);
    if (r.gut == null || craft == null || Math.abs(craft - r.gut) > MAX_PAIR_GAP) continue;
    pairs.set(id, { gut: r.gut, craft });
  }
  return pairs;
}

/**
 * v_gut_calibration: the mean of (detailed − gut) over songs whose current
 * rating has both (pairsOf), each song once.
 */
export function gutOffset(inputs: ScoreInputs, w: Weights): { offset: number; samples: number } {
  const pairs = [...pairsOf(inputs, w).values()];
  const total = pairs.reduce((sum, p) => sum + (p.craft - p.gut), 0);
  return { offset: pairs.length === 0 ? 0 : total / pairs.length, samples: pairs.length };
}

/** A group's own gap, with how many songs rated both ways it rests on. */
export interface CalibrationGroup {
  gap: number;
  songs: number;
}

/**
 * How a gut score becomes a score (migration 0067): in layers, each
 * counting by how much evidence it has.
 *
 * 1. general: the mean gap (detailed − gut) over every song rated both ways.
 * 2. levels: the gap at each gut score 0–10, pulled toward the general
 *    one; a gut 10 can run lower than a gut 6.
 * 3. artists: what is left over, by the song's artist, pulled toward 0.
 *    First, so the artist explains all it can: it counts most.
 * 4. genres: what is left after the artist, by genre, pulled toward 0.
 *    A Logic song is not counted twice, as Logic and again as hip-hop.
 *
 * "Pulled toward": a group with n songs keeps n / (n + evidence) of its own
 * gap. With evidence 5, an artist with 5 songs counts half; with 45, nine
 * tenths. Pure.
 */
export interface Calibration {
  general: number;
  samples: number;
  /** The gap at gut 0, 1 … 10. */
  levels: number[];
  artists: Record<string, CalibrationGroup>;
  genres: Record<string, CalibrationGroup>;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** The level gap at any gut score, half steps between their neighbours. */
export function levelGap(cal: Calibration, gut: number): number {
  const g = Math.max(0, Math.min(10, gut));
  const lo = Math.floor(g);
  const hi = Math.ceil(g);
  return lo === hi ? cal.levels[lo]! : cal.levels[lo]! + (cal.levels[hi]! - cal.levels[lo]!) * (g - lo);
}

export function calibrate(inputs: ScoreInputs, w: Weights): Calibration {
  const pairs = pairsOf(inputs, w);
  const k = w.calibration.evidence;
  const { offset: general, samples } = gutOffset(inputs, w);
  const pulled = (sum: number, n: number, toward: number) => (sum + k * toward) / (n + k);

  const byLevel: number[][] = Array.from({ length: 11 }, () => []);
  for (const p of pairs.values()) byLevel[Math.max(0, Math.min(10, Math.round(p.gut)))]!.push(p.craft - p.gut);
  const levels = byLevel.map((d) => pulled(d.reduce((a, b) => a + b, 0), d.length, general));
  const cal: Calibration = { general, samples, levels, artists: {}, genres: {} };

  const group = (sums: Map<string, number[]>): Record<string, CalibrationGroup> =>
    Object.fromEntries([...sums].map(([key, d]) => [key, { gap: pulled(d.reduce((a, b) => a + b, 0), d.length, 0), songs: d.length }]));

  const afterLevel = new Map([...pairs].map(([id, p]) => [id, p.craft - p.gut - levelGap(cal, p.gut)]));
  const byArtist = new Map<string, number[]>();
  for (const [id, r] of afterLevel) {
    const artist = inputs.artists?.[id];
    if (artist) (byArtist.get(artist) ?? byArtist.set(artist, []).get(artist)!).push(r);
  }
  cal.artists = group(byArtist);

  const byGenre = new Map<string, number[]>();
  for (const [id, r] of afterLevel) {
    const artist = inputs.artists?.[id];
    const left = r - (artist ? (cal.artists[artist]?.gap ?? 0) : 0);
    for (const genre of new Set(inputs.genres?.[id] ?? [])) (byGenre.get(genre) ?? byGenre.set(genre, []).get(genre)!).push(left);
  }
  cal.genres = group(byGenre);
  return cal;
}

/** One gut score's conversion, layer by layer: score = 10 × (gut + offset). Pure. */
export interface Conversion {
  offset: number;
  level: number;
  artist: number;
  genre: number;
}

export function convert(cal: Calibration, gut: number, artist: string | undefined, genres: string[] | undefined): Conversion {
  const level = levelGap(cal, gut);
  const a = artist ? (cal.artists[artist]?.gap ?? 0) : 0;
  const known = [...new Set(genres ?? [])].map((g) => cal.genres[g]?.gap).filter((g): g is number => g !== undefined);
  const genre = known.length ? mean(known) : 0;
  return { offset: level + a + genre, level, artist: a, genre };
}

/**
 * The conversion of every recording whose latest rating is gut only: what
 * gut_conversion holds (src/lib/gut-calibration.ts) and v_recording_score
 * adds to the gut score. Pure.
 */
export function gutConversions(inputs: ScoreInputs, w: Weights, cal = calibrate(inputs, w)): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, r] of Object.entries(inputs.recordings)) {
    if (r.gut == null || craftComposite(r, w) != null) continue;
    out.set(id, convert(cal, r.gut, inputs.artists?.[id], inputs.genres?.[id]).offset);
  }
  return out;
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
  calibration: Calibration;
  recordings: Map<string, Score>;
  albums: Map<string, AlbumScore>;
}

/** Every recording and album score under the given weights. */
export function computeScores(inputs: ScoreInputs, w: Weights): Scores {
  const calibration = calibrate(inputs, w);
  const { general: offset, samples } = calibration;
  const conversions = gutConversions(inputs, w, calibration);

  const kinds = inputs.kinds ?? {};
  const lengths = inputs.lengths ?? {};

  // v_recording_score: a skit has no score.
  const recordings = new Map<string, Score>();
  for (const [id, r] of Object.entries(inputs.recordings)) {
    if (kinds[id] === 'skit') continue;
    const score = recordingScore(r, w, conversions.get(id) ?? offset);
    if (score) recordings.set(id, score);
  }
  // v_recording_score's second half: unrated versions borrow a rated one's score.
  for (const [id, from] of Object.entries(inputs.inherits ?? {})) {
    if (inputs.recordings[id] || kinds[id] === 'skit') continue;
    const score = recordings.get(from);
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
      const left = w.release.trim_lowest ? outliers(rated, w.release.outlier_gap) : new Set<string>();
      const kept = rated.filter((r) => !left.has(r.id));
      let total = 0;
      let weight = 0;
      for (const r of kept) {
        const kind = kinds[r.id] === 'interlude' ? w.release.interlude : 1;
        const byLength = r.length === undefined || mean === null ? 1 : 1 - w.release.length + (w.release.length * r.length) / mean;
        const weak = weakWeight(r.q, w.release.harshness);
        total += kind * byLength * weak * r.q;
        weight += kind * byLength * weak;
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

  return { offset, samples, calibration, recordings, albums };
}

/** Ids ordered best first, ties broken by id so the order is stable. */
export function rank<T extends Score>(scores: Map<string, T>, by: 'quality' | 'personal'): string[] {
  return [...scores.entries()]
    .sort(([a, x], [b, y]) => y[by] - x[by] || (a < b ? -1 : a > b ? 1 : 0))
    .map(([id]) => id);
}
