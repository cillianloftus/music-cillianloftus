/**
 * Listening history from Spotify's extended streaming history export
 * (ARCHITECTURE.md §3, "Listening history"; "As built: listens and recaps").
 *
 * The export is read in the browser. It sends the distinct tracks first,
 * which are kept (matched to a recording where the catalogue has one),
 * then every music stream in batches. Nothing is thrown away for being
 * outside the catalogue: recaps count everything, and a track's listens
 * join its recording when the album is imported later. Importing an
 * overlapping export again adds nothing (plays are unique per user,
 * track, start and source), and listens that Last.fm or ListenBrainz also
 * reported are counted once (listens/dedupe.ts).
 */

import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { PLAY_BATCH, TRACK_BATCH } from './history-parse';
import { listenTrack } from './listens/keys';
import { catalogueIndex } from './listens/match';
import { savePlays, saveTracks } from './listens/store';

const spotifyUri = z.string().regex(/^spotify:track:[A-Za-z0-9]{22}$/);

export const tracksRequest = z
  .object({
    tracks: z
      .array(
        z
          .object({
            uri: spotifyUri,
            name: z.string().min(1).max(500),
            artist: z.string().min(1).max(500),
            album: z.string().max(500).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(TRACK_BATCH),
  })
  .strict();

const flag = z.boolean().nullable();
const short = (max: number) => z.string().max(max).nullable();

export const playsRequest = z
  .object({
    plays: z
      .array(
        z
          .object({
            uri: spotifyUri,
            played_at: z.iso.datetime(),
            ms_played: z.number().int().min(0).max(24 * 60 * 60 * 1000),
            skipped: flag,
            shuffle: flag,
            offline: flag,
            incognito: flag,
            platform: short(100),
            country: short(8),
            reason_start: short(40),
            reason_end: short(40),
          })
          .strict(),
      )
      .min(1)
      .max(PLAY_BATCH),
  })
  .strict();
export type PlaysRequest = z.infer<typeof playsRequest>;

const keyOf = (uri: string) => `spotify:${uri.slice('spotify:track:'.length)}`;

/** Keeps the export's tracks. Returns how many are in the catalogue. */
export async function addTracks(tracks: z.infer<typeof tracksRequest>['tracks']): Promise<number> {
  const rows = tracks.map((t) => listenTrack({ artist: t.artist, title: t.name, album: t.album, spotify_id: t.uri.slice('spotify:track:'.length) }));
  return saveTracks(rows, await catalogueIndex());
}

/** Adds plays, skipping any already held. Returns how many were new. */
export async function addPlays(userId: string, plays: PlaysRequest['plays']): Promise<number> {
  return savePlays(
    userId,
    'spotify_export',
    plays.map(({ uri, ...p }) => ({ ...p, track_key: keyOf(uri) })),
  );
}

export interface HistorySummary {
  /** Counted plays: 30 seconds or more, each moment of listening once. */
  plays: number;
  /** Distinct catalogue recordings among them. */
  recordings: number;
  /** Distinct tracks, in the catalogue or not. */
  tracks: number;
  first: string | null;
  last: string | null;
  hours: number;
}

export async function historySummary(userId: string): Promise<HistorySummary> {
  const row = await env.DB.prepare(
    `SELECT count(*) AS plays, count(DISTINCT recording_id) AS recordings, count(DISTINCT track_key) AS tracks,
            min(played_at) AS first, max(played_at) AS last, coalesce(sum(ms_played), 0) / 3600000.0 AS hours
     FROM play WHERE user_id = ? AND counted = 1`,
  )
    .bind(userId)
    .first<HistorySummary>();
  return row ?? { plays: 0, recordings: 0, tracks: 0, first: null, last: null, hours: 0 };
}

export interface Divergence {
  recording_id: string;
  title: string;
  album_id: string | null;
  album_title: string | null;
  artist: string | null;
  plays: number;
  quality_score: number;
  /** Where the track sits among rated tracks, 0 (lowest) to 1 (highest). */
  play_rank: number;
  score_rank: number;
}

/**
 * The interesting query (ARCHITECTURE.md §3): where what is rated and what
 * is played disagree. Rated tracks are ranked by plays and by score, each
 * as a percentile; the biggest gaps either way are the surprises.
 */
export async function divergence(userId: string, limit = 10): Promise<{ underplayed: Divergence[]; overplayed: Divergence[] }> {
  const { results } = await env.DB.prepare(
    `WITH rated AS (
       SELECT s.recording_id, s.quality_score,
              (SELECT count(*) FROM play p WHERE p.recording_id = s.recording_id AND p.user_id = ?1 AND p.counted = 1) AS plays
       FROM v_recording_score s WHERE s.user_id = ?1
     ),
     ranked AS (
       SELECT *, percent_rank() OVER (ORDER BY plays) AS play_rank,
                 percent_rank() OVER (ORDER BY quality_score) AS score_rank
       FROM rated
     )
     SELECT k.recording_id, r.title, k.plays, k.quality_score, k.play_rank, k.score_rank,
            ra.release_group_id AS album_id, g.title AS album_title,
            (SELECT a.name FROM artist_credit c JOIN artist a ON a.id = c.artist_id
             WHERE c.entity_type = 'recording' AND c.entity_id = r.id AND c.role = 'primary'
             ORDER BY c.position LIMIT 1) AS artist
     FROM ranked k
     JOIN recording r ON r.id = k.recording_id
     LEFT JOIN v_recording_album ra ON ra.recording_id = r.id
     LEFT JOIN release_group g ON g.id = ra.release_group_id
     WHERE (SELECT count(*) FROM rated) >= 5`,
  )
    .bind(userId)
    .all<Divergence>();

  const gap = (d: Divergence) => d.score_rank - d.play_rank;
  // A divergence needs plays on the other side: rarely played means less than
  // the middle of the library; heavily played, more than it.
  const underplayed = results
    .filter((d) => gap(d) > 0.25)
    .sort((a, b) => gap(b) - gap(a) || b.quality_score - a.quality_score)
    .slice(0, limit);
  const overplayed = results
    .filter((d) => gap(d) < -0.25 && d.plays > 0)
    .sort((a, b) => gap(a) - gap(b) || b.plays - a.plays)
    .slice(0, limit);
  return { underplayed, overplayed };
}

/** Plays per recording for one user, for the given recordings. */
export async function playCounts(userId: string, recordingIds: string[]): Promise<Map<string, number>> {
  if (recordingIds.length === 0) return new Map();
  const { results } = await env.DB.prepare(
    `SELECT recording_id, count(*) AS plays FROM play
     WHERE user_id = ? AND counted = 1 AND recording_id IN (SELECT value FROM json_each(?))
     GROUP BY recording_id`,
  )
    .bind(userId, JSON.stringify(recordingIds))
    .all<{ recording_id: string; plays: number }>();
  return new Map(results.map((r) => [r.recording_id, r.plays]));
}

export interface TrackListening {
  total: number;
  first: string;
  last: string;
  /** Among every recording played: 1 is the most played. */
  rank: number;
  of: number;
  /** Plays per month from the first play to now, zero where none. */
  months: { month: string; count: number }[];
  /** Where the plays came from: spotify_export, lastfm, listenbrainz. */
  sources: string[];
}

/** How one track has been listened to, for its page. Null before any play. */
export async function trackListening(userId: string, recordingId: string, now = new Date()): Promise<TrackListening | null> {
  const [summary, months, ranks] = await env.DB.batch([
    env.DB.prepare(
      `SELECT count(*) AS total, min(played_at) AS first, max(played_at) AS last, json_group_array(DISTINCT source) AS sources
       FROM play WHERE user_id = ? AND recording_id = ? AND counted = 1`,
    ).bind(userId, recordingId),
    env.DB.prepare(
      `SELECT substr(played_at, 1, 7) AS month, count(*) AS count FROM play
       WHERE user_id = ? AND recording_id = ? AND counted = 1 GROUP BY month ORDER BY month`,
    ).bind(userId, recordingId),
    env.DB.prepare(
      `WITH counts AS (SELECT recording_id, count(*) AS n FROM play WHERE user_id = ?1 AND counted = 1 AND recording_id IS NOT NULL GROUP BY recording_id)
       SELECT (SELECT count(*) FROM counts c WHERE c.n > (SELECT n FROM counts WHERE recording_id = ?2)) + 1 AS rank,
              (SELECT count(*) FROM counts) AS of`,
    ).bind(userId, recordingId),
  ]);
  const s = summary!.results[0] as { total: number; first: string | null; last: string | null; sources: string } | undefined;
  if (!s?.total || !s.first || !s.last) return null;
  const r = ranks!.results[0] as { rank: number; of: number };
  const rows = months!.results as { month: string; count: number }[];
  // Run the months on to now, so a track gone quiet shows the quiet.
  const thisMonth = now.toISOString().slice(0, 7);
  if (rows.at(-1)!.month < thisMonth) rows.push({ month: thisMonth, count: 0 });
  return {
    total: s.total,
    first: s.first,
    last: s.last,
    rank: r.rank,
    of: r.of,
    months: fillPlayMonths(rows),
    sources: (JSON.parse(s.sources) as string[]).filter(Boolean),
  };
}

/** Every month between the first and last given, zero where there were no plays. */
export function fillPlayMonths(rows: { month: string; count: number }[]): { month: string; count: number }[] {
  if (rows.length === 0) return [];
  const counts = new Map(rows.map((r) => [r.month, r.count]));
  const out: { month: string; count: number }[] = [];
  let [y, m] = rows[0]!.month.split('-').map(Number) as [number, number];
  const last = rows.at(-1)!.month;
  for (let guard = 0; guard < 600; guard++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    out.push({ month: key, count: counts.get(key) ?? 0 });
    if (key >= last) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}
