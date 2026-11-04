/**
 * Turns Spotify's extended streaming history JSON into tracks and plays.
 * Runs in the browser. Podcasts, audiobooks and streams under 30 seconds
 * are left out: under 30 seconds is not a play by Spotify's own rule.
 */

export interface ParsedTrack {
  uri: string;
  name: string;
  artist: string;
  album: string | null;
}

export interface ParsedPlay {
  uri: string;
  played_at: string;
  ms_played: number;
}

export const MIN_PLAY_MS = 30_000;

/** Request sizes: small enough that each request stays cheap for the Worker. */
export const MATCH_BATCH = 5000;
export const PLAY_BATCH = 2000;

/** Adds one export file's entries to the running totals. Returns how many entries were plays. */
export function collectHistory(json: unknown, tracks: Map<string, ParsedTrack>, plays: ParsedPlay[]): number {
  if (!Array.isArray(json)) throw new Error('Not a streaming history file.');
  let counted = 0;
  for (const entry of json as Record<string, unknown>[]) {
    const uri = entry.spotify_track_uri;
    const name = entry.master_metadata_track_name;
    const artist = entry.master_metadata_album_artist_name;
    const ms = entry.ms_played;
    const ts = entry.ts;
    if (typeof uri !== 'string' || !/^spotify:track:[A-Za-z0-9]{22}$/.test(uri)) continue;
    if (typeof name !== 'string' || typeof artist !== 'string' || !name || !artist) continue;
    if (typeof ms !== 'number' || ms < MIN_PLAY_MS || typeof ts !== 'string') continue;
    const played_at = new Date(ts);
    if (Number.isNaN(played_at.getTime())) continue;
    if (!tracks.has(uri)) {
      const album = entry.master_metadata_album_album_name;
      tracks.set(uri, { uri, name: name.slice(0, 500), artist: artist.slice(0, 500), album: typeof album === 'string' && album ? album.slice(0, 500) : null });
    }
    plays.push({ uri, played_at: played_at.toISOString().replace('.000Z', 'Z'), ms_played: Math.min(ms, 86_400_000) });
    counted += 1;
  }
  return counted;
}

/** Export files worth reading: the audio history, under any folder. */
export const isAudioHistory = (name: string) => /Streaming_History_Audio[^/]*\.json$/i.test(name) || /endsong[^/]*\.json$/i.test(name);
