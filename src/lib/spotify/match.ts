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
import { MARKET, type SpotifyClient } from './client';

interface SpotifyTrack {
  id: string;
  name: string;
  artists: { name: string }[];
  album?: { id: string; name: string; album_type: string };
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
  album_id: string | null;
  album_title: string | null;
  album_spotify_id: string | null;
}

export interface MatchResult {
  /** recording id -> Spotify track id, for every recording that has one. */
  matched: Map<string, string>;
  unmatched: { id: string; title: string; artist: string | null }[];
}

/** Search terms cannot carry quotes or field syntax. */
const term = (value: string) => value.replace(/["':]/g, ' ').replace(/\s+/g, ' ').trim();

async function search(spotify: SpotifyClient, q: string, limit: number): Promise<SpotifyTrack[]> {
  const params = new URLSearchParams({ q, type: 'track', limit: String(limit), market: MARKET });
  const result = await spotify.get<SearchResponse>(`/search?${params}`);
  return result.tracks.items;
}

async function findTrack(spotify: SpotifyClient, recording: Candidate): Promise<SpotifyTrack | null> {
  if (recording.isrc) {
    const [byIsrc] = await search(spotify, `isrc:${recording.isrc}`, 1);
    if (byIsrc) return byIsrc;
  }

  if (!recording.artist) return null;
  const title = normaliseTitle(recording.title);
  const artist = normaliseName(recording.artist);
  const candidates = await search(spotify, `track:${term(recording.title)} artist:${term(recording.artist)}`, 5);
  const match = candidates.find(
    (track) =>
      normaliseTitle(track.name) === title && track.artists.some((a) => normaliseName(a.name) === artist),
  );
  return match ?? null;
}

/**
 * The Spotify album a matched track sits on is this recording's album when
 * the titles agree, edition words aside, and it is not a compilation (a
 * hit can live on a best-of). Then the album's empty spotify_id is filled.
 */
export function sameAlbum(recording: Pick<Candidate, 'album_title'>, track: SpotifyTrack): boolean {
  return Boolean(
    recording.album_title &&
      track.album &&
      track.album.album_type !== 'compilation' &&
      normaliseTitle(track.album.name) === normaliseTitle(recording.album_title),
  );
}

export async function resolveSpotifyIds(spotify: SpotifyClient, recordingIds: string[]): Promise<MatchResult> {
  const { results } = await env.DB.prepare(
    `SELECT rec.id, rec.title, rec.isrc, rec.spotify_id,
            (SELECT a.name FROM artist_credit c JOIN artist a ON a.id = c.artist_id
             WHERE c.entity_type = 'recording' AND c.entity_id = rec.id AND c.role = 'primary'
             ORDER BY c.position LIMIT 1) AS artist,
            g.id AS album_id, g.title AS album_title, g.spotify_id AS album_spotify_id
     FROM recording rec
     LEFT JOIN v_recording_album ra ON ra.recording_id = rec.id
     LEFT JOIN release_group g ON g.id = ra.release_group_id
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
    const track = await findTrack(spotify, recording);
    if (!track) {
      unmatched.push({ id: recording.id, title: recording.title, artist: recording.artist });
      continue;
    }
    const spotifyId = track.id;
    matched.set(recording.id, spotifyId);
    if (recording.album_id && !recording.album_spotify_id && sameAlbum(recording, track)) {
      await env.DB.prepare(
        `UPDATE release_group SET spotify_id = ?1
         WHERE id = ?2 AND spotify_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM release_group WHERE spotify_id = ?1)`,
      )
        .bind(track.album!.id, recording.album_id)
        .run();
      recording.album_spotify_id = track.album!.id;
      for (const other of results) if (other.album_id === recording.album_id) other.album_spotify_id = track.album!.id;
    }
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
