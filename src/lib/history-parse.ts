/**
 * Turns Spotify's extended streaming history JSON into tracks and plays.
 * Runs in the browser. Podcasts and audiobooks are left out; every music
 * stream is kept, short ones too (they are skips, and never count as
 * plays: see listens/dedupe.ts). Kept from each entry: the track, when,
 * how long, skipped, shuffle, offline, incognito, platform, country and
 * why it started and ended. The IP address is not.
 *
 * Spotify stamps a stream when it stopped (`ts`); `played_at` here is when
 * it started, `ts` less `ms_played`, which is what scrobbles stamp, so the
 * two line up when deduplicated.
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
  skipped: boolean | null;
  shuffle: boolean | null;
  offline: boolean | null;
  incognito: boolean | null;
  platform: string | null;
  country: string | null;
  reason_start: string | null;
  reason_end: string | null;
}

/** Request sizes: small enough that each request stays cheap for the Worker. */
export const TRACK_BATCH = 2000;
export const PLAY_BATCH = 2000;

const bool = (v: unknown) => (typeof v === 'boolean' ? v : null);
const text = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : null);

/** "Android OS 9 API 28 (samsung, SM-G950F)" → "android"; "windows", "ios", "web_player"... */
export function platformOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  const s = raw.toLowerCase();
  for (const [needle, name] of [
    ['android', 'android'],
    ['ios', 'ios'],
    ['iphone', 'ios'],
    ['ipad', 'ios'],
    ['windows', 'windows'],
    ['os x', 'mac'],
    ['osx', 'mac'],
    ['macos', 'mac'],
    ['linux', 'linux'],
    ['web_player', 'web'],
    ['webplayer', 'web'],
    ['cast', 'cast'],
    ['sonos', 'speaker'],
    ['partner', 'speaker'],
    ['playstation', 'console'],
    ['xbox', 'console'],
  ] as const) {
    if (s.includes(needle)) return name;
  }
  return s.split(/[\s(]/)[0]!.slice(0, 40) || null;
}

/** Adds one export file's entries to the running totals. Returns how many entries were music streams. */
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
    if (typeof ms !== 'number' || ms < 0 || typeof ts !== 'string') continue;
    const ended = new Date(ts);
    if (Number.isNaN(ended.getTime())) continue;
    if (!tracks.has(uri)) {
      tracks.set(uri, { uri, name: name.slice(0, 500), artist: artist.slice(0, 500), album: text(entry.master_metadata_album_album_name, 500) });
    }
    const ms_played = Math.min(Math.round(ms), 86_400_000);
    plays.push({
      uri,
      played_at: new Date(ended.getTime() - ms_played).toISOString(),
      ms_played,
      skipped: bool(entry.skipped),
      shuffle: bool(entry.shuffle),
      offline: bool(entry.offline),
      incognito: bool(entry.incognito_mode),
      platform: platformOf(entry.platform),
      country: text(entry.conn_country, 8),
      reason_start: text(entry.reason_start, 40),
      reason_end: text(entry.reason_end, 40),
    });
    counted += 1;
  }
  return counted;
}

/** Export files worth reading: the audio history, under any folder. */
export const isAudioHistory = (name: string) => /Streaming_History_Audio[^/]*\.json$/i.test(name) || /endsong[^/]*\.json$/i.test(name);
