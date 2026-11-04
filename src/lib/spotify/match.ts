/**
 * Finds Spotify track ids for recordings that lack one.
 *
 *   1. ISRC search: exact, when the recording has an ISRC.
 *   2. Title and artist search: accepted only when the normalised title
 *      matches and the primary artist is among the track's artists.
 *
 * Matches are stored in recording.spotify_id, filling nulls only, so the
 * next push is instant. Anything not confidently matched is reported back
 * rather than guessed.
 */

import { env } from 'cloudflare:workers';
import { normaliseName, normaliseTitle } from '../text';
import type { SpotifyClient } from './client';

interface SpotifyTrack {
  id: string;
  name: string;
  artists: { name: string }[];
}

interface SearchResponse {
  tracks: { items: SpotifyTrack[] };
}

interface Candidate {
  id: string;
  title: string;
  isrc: string | null;
  spotify_id: string | null;
  artist: string | null;
}

export interface MatchResult {
  /** recording id -> Spotify track id, for every recording that has one. */
  matched: Map<string, string>;
  unmatched: { id: string; title: string; artist: string | null }[];
}

/** Search terms cannot carry quotes or field syntax. */
const term = (value: string) => value.replace(/["':]/g, ' ').replace(/\s+/g, ' ').trim();

async function search(spotify: SpotifyClient, q: string, limit: number): Promise<SpotifyTrack[]> {
  const params = new URLSearchParams({ q, type: 'track', limit: String(limit), market: 'from_token' });
  const result = await spotify.get<SearchResponse>(`/search?${params}`);
  return result.tracks.items;
}

async function findTrack(spotify: SpotifyClient, recording: Candidate): Promise<string | null> {
  if (recording.isrc) {
    const [byIsrc] = await search(spotify, `isrc:${recording.isrc}`, 1);
    if (byIsrc) return byIsrc.id;
  }

  if (!recording.artist) return null;
  const title = normaliseTitle(recording.title);
  const artist = normaliseName(recording.artist);
  const candidates = await search(spotify, `track:${term(recording.title)} artist:${term(recording.artist)}`, 5);
  const match = candidates.find(
    (track) =>
      normaliseTitle(track.name) === title && track.artists.some((a) => normaliseName(a.name) === artist),
  );
  return match?.id ?? null;
}

export async function resolveSpotifyIds(spotify: SpotifyClient, recordingIds: string[]): Promise<MatchResult> {
  const { results } = await env.DB.prepare(
    `SELECT rec.id, rec.title, rec.isrc, rec.spotify_id,
            (SELECT a.name FROM artist_credit c JOIN artist a ON a.id = c.artist_id
             WHERE c.entity_type = 'recording' AND c.entity_id = rec.id AND c.role = 'primary'
             ORDER BY c.position LIMIT 1) AS artist
     FROM recording rec
     WHERE rec.id IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(recordingIds))
    .all<Candidate>();

  const matched = new Map<string, string>();
  const unmatched: MatchResult['unmatched'] = [];

  for (const recording of results) {
    if (recording.spotify_id) {
      matched.set(recording.id, recording.spotify_id);
      continue;
    }
    const spotifyId = await findTrack(spotify, recording);
    if (!spotifyId) {
      unmatched.push({ id: recording.id, title: recording.title, artist: recording.artist });
      continue;
    }
    matched.set(recording.id, spotifyId);
    // Fill nulls only. Another recording may already hold this Spotify id
    // (two catalogue entries for one master); then use it without storing.
    await env.DB.prepare(
      `UPDATE recording SET spotify_id = ?1
       WHERE id = ?2 AND spotify_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM recording WHERE spotify_id = ?1)`,
    )
      .bind(spotifyId, recording.id)
      .run();
  }

  return { matched, unmatched };
}
