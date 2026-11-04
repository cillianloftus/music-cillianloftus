/**
 * Listening history from Spotify's extended streaming history export
 * (ARCHITECTURE.md §3, "Listening history"; build step 13).
 *
 * The export is read in the browser. It sends the distinct tracks first;
 * this side matches them to recordings in the catalogue and answers with
 * the matches; the browser then sends the plays of matched tracks in
 * batches. That keeps every request small, and nothing about tracks
 * outside the catalogue is stored. Importing an overlapping export again
 * adds nothing (the play table is unique per user, recording, time and
 * source), and a later import picks up plays of albums added since.
 */

import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { normaliseName, normaliseTitle } from './text';

import { MATCH_BATCH, MIN_PLAY_MS, PLAY_BATCH } from './history-parse';

export const historyTrack = z
  .object({
    uri: z.string().regex(/^spotify:track:[A-Za-z0-9]{22}$/),
    name: z.string().min(1).max(500),
    artist: z.string().min(1).max(500),
    album: z.string().max(500).nullable(),
  })
  .strict();
export type HistoryTrack = z.infer<typeof historyTrack>;

export const matchRequest = z.object({ tracks: z.array(historyTrack).min(1).max(MATCH_BATCH) }).strict();

export const playsRequest = z
  .object({
    plays: z
      .array(
        z
          .object({
            recording_id: z.uuid().or(z.string().regex(/^[A-Za-z0-9-]{1,64}$/)),
            played_at: z.iso.datetime(),
            ms_played: z.number().int().min(MIN_PLAY_MS).max(24 * 60 * 60 * 1000),
          })
          .strict(),
      )
      .min(1)
      .max(PLAY_BATCH),
  })
  .strict();
export type PlaysRequest = z.infer<typeof playsRequest>;

export type MatchHow = 'spotify_id' | 'title_artist';

interface CatalogueRow {
  id: string;
  title: string;
  spotify_id: string | null;
  artists: string | null;
  albums: string | null;
}

/**
 * Recording ids for the tracks that are in the catalogue. By Spotify id
 * where a recording holds one; otherwise by title and primary artist,
 * normalised, preferring the recording whose album has the same name when
 * several share a title. A title alone never matches.
 */
export async function matchTracks(tracks: HistoryTrack[]): Promise<Record<string, { recording_id: string; how: MatchHow }>> {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.title, r.spotify_id,
            (SELECT json_group_array(a.name) FROM artist_credit c JOIN artist a ON a.id = c.artist_id
             WHERE c.entity_type = 'recording' AND c.entity_id = r.id AND c.role = 'primary') AS artists,
            (SELECT json_group_array(g.title) FROM track t JOIN release x ON x.id = t.release_id
             JOIN release_group g ON g.id = x.release_group_id WHERE t.recording_id = r.id) AS albums
     FROM recording r`,
  ).all<CatalogueRow>();

  const bySpotify = new Map<string, string>();
  const byName = new Map<string, CatalogueRow[]>();
  for (const row of results) {
    if (row.spotify_id) bySpotify.set(row.spotify_id, row.id);
    const title = normaliseTitle(row.title);
    for (const artist of JSON.parse(row.artists ?? '[]') as string[]) {
      const key = `${normaliseName(artist)}\u0000${title}`;
      const list = byName.get(key);
      if (list) list.push(row);
      else byName.set(key, [row]);
    }
  }

  const matches: Record<string, { recording_id: string; how: MatchHow }> = {};
  for (const track of tracks) {
    const id = track.uri.slice('spotify:track:'.length);
    const exact = bySpotify.get(id);
    if (exact) {
      matches[track.uri] = { recording_id: exact, how: 'spotify_id' };
      continue;
    }
    const candidates = byName.get(`${normaliseName(track.artist)}\u0000${normaliseTitle(track.name)}`);
    if (!candidates?.length) continue;
    const album = track.album ? normaliseTitle(track.album) : null;
    const onAlbum = album
      ? candidates.find((c) => (JSON.parse(c.albums ?? '[]') as string[]).some((a) => normaliseTitle(a) === album))
      : undefined;
    matches[track.uri] = { recording_id: (onAlbum ?? candidates[0]!).id, how: 'title_artist' };
  }
  return matches;
}

/** Adds plays, skipping any already held and any naming no recording. Returns how many were new. */
export async function addPlays(userId: string, plays: PlaysRequest['plays']): Promise<number> {
  const rows = plays.map((p) => ({ ...p, id: crypto.randomUUID() }));
  const result = await env.DB.prepare(
    `INSERT INTO play (id, user_id, recording_id, played_at, ms_played, source)
     SELECT j.value ->> '$.id', ?1, r.id, j.value ->> '$.played_at', j.value ->> '$.ms_played', 'spotify_export'
     FROM json_each(?2) j
     JOIN recording r ON r.id = j.value ->> '$.recording_id'
     WHERE true
     ON CONFLICT (user_id, recording_id, played_at, source) DO NOTHING`,
  )
    .bind(userId, JSON.stringify(rows))
    .run();
  return result.meta.changes ?? 0;
}

export interface HistorySummary {
  plays: number;
  recordings: number;
  first: string | null;
  last: string | null;
  hours: number;
}

export async function historySummary(userId: string): Promise<HistorySummary> {
  const row = await env.DB.prepare(
    `SELECT count(*) AS plays, count(DISTINCT recording_id) AS recordings,
            min(played_at) AS first, max(played_at) AS last, coalesce(sum(ms_played), 0) / 3600000.0 AS hours
     FROM play WHERE user_id = ?`,
  )
    .bind(userId)
    .first<HistorySummary>();
  return row ?? { plays: 0, recordings: 0, first: null, last: null, hours: 0 };
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
              (SELECT count(*) FROM play p WHERE p.recording_id = s.recording_id AND p.user_id = ?1) AS plays
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
     WHERE user_id = ? AND recording_id IN (SELECT value FROM json_each(?))
     GROUP BY recording_id`,
  )
    .bind(userId, JSON.stringify(recordingIds))
    .all<{ recording_id: string; plays: number }>();
  return new Map(results.map((r) => [r.recording_id, r.plays]));
}
