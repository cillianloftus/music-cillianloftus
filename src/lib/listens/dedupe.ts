/**
 * One moment of listening, counted once.
 *
 * The same stream can reach the play table from several sources: the
 * Spotify export has it, and so does Last.fm if Spotify was scrobbling,
 * and ListenBrainz if Last.fm was forwarding. Every copy is kept (each
 * source knows different things), but exactly one counts. The rule:
 *
 * 1. Only listens from different sources can be copies of each other. Two
 *    listens from one source are two listens: a source never reports one
 *    stream twice (the table is unique per track, time and source), and a
 *    song played twice in a row is two plays.
 *
 * 2. They must be the same song: the same catalogue recording, or the same
 *    lead artist and title as each source named them (keys.ts: normalised,
 *    "feat." dropped, case and punctuation ignored).
 *
 * 3. They must be at the same moment. A listen with a known length covers
 *    its start to its end; a scrobble is an instant (Last.fm stamps the
 *    start, some scrobblers the end). Two listens are at the same moment
 *    when either's instant falls within the other's span, widened by
 *    SLACK_MS each side for clocks that disagree. Two instants (Last.fm
 *    against ListenBrainz) must be within SLACK_MS of each other.
 *
 * 4. Each listen is a copy of at most one other, and each counted listen
 *    has at most one copy per source. Where a run of repeats makes several
 *    pairings possible, the closest starts pair first, so a song looped
 *    five times pairs five to five, not five to one.
 *
 * 5. The copy that counts is the one with the most detail: the Spotify
 *    export (length, skips, shuffle, device) first, then ListenBrainz,
 *    then Last.fm, then manual. The others name it in duplicate_of and are
 *    never counted anywhere: recaps, play counts, the rating queue.
 *
 * Streams under 30 seconds (Spotify's own rule for a play) are kept for
 * skip statistics but never count and never pair.
 */

export const SLACK_MS = 120_000;
export const MIN_COUNTED_MS = 30_000;
/** No single listen runs longer than this; pairings are only looked for this close. */
const NEAR_MS = 6 * 3_600_000;

/** Most detail first. */
export const SOURCE_RANK = ['spotify_export', 'listenbrainz', 'lastfm', 'manual'] as const;
export type PlaySource = (typeof SOURCE_RANK)[number];

export interface DedupePlay {
  id: string;
  source: PlaySource;
  /** Epoch ms when listening started. */
  start: number;
  ms_played: number | null;
  recording_id: string | null;
  artist_key: string;
  title_key: string;
}

export interface DedupeResult {
  id: string;
  counted: 0 | 1;
  duplicate_of: string | null;
}

const sameSong = (a: DedupePlay, b: DedupePlay) =>
  (a.recording_id !== null && a.recording_id === b.recording_id) || (a.artist_key === b.artist_key && a.title_key === b.title_key && a.title_key !== '');

/** How far apart two listens are; Infinity when they are not the same moment. */
export function distance(a: DedupePlay, b: DedupePlay): number {
  const aEnd = a.ms_played != null ? a.start + a.ms_played : null;
  const bEnd = b.ms_played != null ? b.start + b.ms_played : null;
  const gap = Math.abs(a.start - b.start);
  if (aEnd === null && bEnd === null) return gap <= SLACK_MS ? gap : Infinity;
  // One span against the other's start (and end, for scrobblers that stamp it).
  const within = (s: number, e: number, t: number) => t >= s - SLACK_MS && t <= e + SLACK_MS;
  const touches =
    (aEnd !== null && within(a.start, aEnd, b.start)) ||
    (bEnd !== null && within(b.start, bEnd, a.start)) ||
    (aEnd !== null && bEnd !== null && a.start <= bEnd + SLACK_MS && b.start <= aEnd + SLACK_MS);
  return touches ? gap : Infinity;
}

const counts = (p: DedupePlay) => p.ms_played === null || p.ms_played >= MIN_COUNTED_MS;

/** Which listens count and which are copies, for listens in one stretch of time. */
export function dedupe(plays: DedupePlay[]): DedupeResult[] {
  const out = new Map<string, DedupeResult>();
  for (const p of plays) out.set(p.id, { id: p.id, counted: 0, duplicate_of: null });

  // Clusters: a counted listen and the sources already paired to it.
  const clusters: { primary: DedupePlay; sources: Set<string> }[] = [];
  for (const source of SOURCE_RANK) {
    const incoming = plays.filter((p) => p.source === source && counts(p));
    if (incoming.length === 0) continue;
    // Every possible pairing with an existing cluster, closest first.
    const pairs: { play: DedupePlay; cluster: number; d: number }[] = [];
    if (clusters.length > 0) {
      const sorted = clusters.map((c, i) => ({ c, i })).sort((x, y) => x.c.primary.start - y.c.primary.start);
      for (const play of incoming) {
        // Clusters near in time only: no listen spans more than a few hours.
        let lo = 0;
        let hi = sorted.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (sorted[mid]!.c.primary.start < play.start - NEAR_MS) lo = mid + 1;
          else hi = mid;
        }
        for (let k = lo; k < sorted.length; k++) {
          const { c, i } = sorted[k]!;
          if (c.primary.start > play.start + NEAR_MS) break;
          if (c.sources.has(source) || !sameSong(c.primary, play)) continue;
          const d = distance(c.primary, play);
          if (d !== Infinity) pairs.push({ play, cluster: i, d });
        }
      }
      pairs.sort((x, y) => x.d - y.d || x.play.start - y.play.start || x.play.id.localeCompare(y.play.id));
    }
    const paired = new Set<string>();
    const taken = new Set<number>();
    for (const { play, cluster, d } of pairs) {
      if (paired.has(play.id) || taken.has(cluster) || d === Infinity) continue;
      paired.add(play.id);
      taken.add(cluster);
      clusters[cluster]!.sources.add(source);
      out.set(play.id, { id: play.id, counted: 0, duplicate_of: clusters[cluster]!.primary.id });
    }
    for (const play of incoming) {
      if (paired.has(play.id)) continue;
      clusters.push({ primary: play, sources: new Set([source]) });
      out.set(play.id, { id: play.id, counted: 1, duplicate_of: null });
    }
  }
  return [...out.values()];
}
