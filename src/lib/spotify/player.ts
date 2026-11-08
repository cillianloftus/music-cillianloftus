/**
 * Now playing: Spotify Connect, read and steered through the Web API.
 * The music plays in Spotify's own app (the phone, a speaker, the
 * desktop); this site only reads what is on and sends it commands, so no
 * audio passes through here. Control needs Spotify Premium and the three
 * player scopes (granted on reconnecting at /manage/spotify).
 *
 *   GET  /me/player                 what is on, where, how far in
 *   GET  /me/player/devices         somewhere to play when nothing is active
 *   PUT  /me/player/play|pause      (play takes a context or track uris)
 *   POST /me/player/next|previous
 *   PUT  /me/player/seek|shuffle|repeat
 */

import { MARKET, SpotifyError, type SpotifyClient } from './client';
import type { NowState } from './now-state';

interface ApiImage {
  url: string;
  width: number | null;
}

interface ApiPlayback {
  is_playing: boolean;
  progress_ms: number | null;
  shuffle_state: boolean;
  repeat_state: 'off' | 'track' | 'context';
  currently_playing_type: 'track' | 'episode' | 'ad' | 'unknown';
  device: { id: string | null; name: string; type: string; volume_percent: number | null } | null;
  item: {
    id: string;
    name: string;
    duration_ms: number;
    artists: { id: string; name: string }[];
    album: { id: string; name: string; images: ApiImage[] };
  } | null;
}

export type { NowState };

/** Why a command could not be carried out, in words for the page. */
export class PlayerError extends Error {
  constructor(
    message: string,
    readonly reason: 'scope' | 'premium' | 'no-device' | 'other',
  ) {
    super(message);
    this.name = 'PlayerError';
  }
}

function explain(error: unknown): never {
  if (error instanceof SpotifyError) {
    if (error.status === 401 || (error.status === 403 && /scope/i.test(error.message))) {
      throw new PlayerError('Reconnect Spotify on Manage › Spotify to let this site control playback.', 'scope');
    }
    if (error.status === 403) throw new PlayerError('Spotify only lets Premium accounts be controlled from elsewhere.', 'premium');
    if (error.status === 404) throw new PlayerError('Open Spotify on your phone or computer first, so there is somewhere to play.', 'no-device');
  }
  throw error;
}

export function toState(p: ApiPlayback | undefined, now = Date.now()): NowState | null {
  if (!p) return null;
  const item = p.currently_playing_type === 'track' ? p.item : null;
  const art = item ? ([...item.album.images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? null) : null;
  return {
    playing: p.is_playing,
    progressMs: p.progress_ms ?? 0,
    at: now,
    shuffle: p.shuffle_state,
    repeat: p.repeat_state,
    device: p.device ? { name: p.device.name, type: p.device.type } : null,
    track: item
      ? {
          spotifyId: item.id,
          title: item.name,
          artists: item.artists.map((a) => a.name),
          album: item.album.name,
          albumSpotifyId: item.album.id,
          art,
          durationMs: item.duration_ms,
        }
      : null,
  };
}

/** What is on now, or null when nothing has played lately. */
export async function nowPlaying(client: SpotifyClient): Promise<NowState | null> {
  try {
    return toState(await client.get<ApiPlayback | undefined>(`/me/player?market=${MARKET}`));
  } catch (error) {
    explain(error);
  }
}

export type PlayerCommand =
  | { action: 'play' | 'pause' | 'next' | 'previous' }
  | { action: 'seek'; positionMs: number }
  | { action: 'shuffle'; on: boolean }
  | { action: 'repeat'; mode: 'off' | 'track' | 'context' }
  /** A track (in its album, so the album plays on after it) or a whole album. */
  | { action: 'start'; track?: string; album?: string };

/** The device to wake when none is active: a phone first, else whatever Spotify lists first. */
async function someDevice(client: SpotifyClient): Promise<string> {
  const { devices } = await client.get<{ devices: { id: string | null; type: string; is_active: boolean; is_restricted: boolean }[] }>('/me/player/devices');
  const usable = devices.filter((d) => d.id && !d.is_restricted);
  const pick = usable.find((d) => d.is_active) ?? usable.find((d) => d.type === 'Smartphone') ?? usable[0];
  if (!pick) throw new PlayerError('Open Spotify on your phone or computer first, so there is somewhere to play.', 'no-device');
  return pick.id!;
}

export async function control(client: SpotifyClient, command: PlayerCommand): Promise<void> {
  const send = async (deviceId?: string) => {
    const device = deviceId ? `device_id=${deviceId}` : '';
    const q = (extra: string) => [extra, device].filter(Boolean).join('&');
    switch (command.action) {
      case 'play':
        return client.put(`/me/player/play?${q('')}`, undefined);
      case 'pause':
        return client.put(`/me/player/pause?${q('')}`, undefined);
      case 'next':
        return client.post(`/me/player/next?${q('')}`, undefined);
      case 'previous':
        return client.post(`/me/player/previous?${q('')}`, undefined);
      case 'seek':
        return client.put(`/me/player/seek?${q(`position_ms=${Math.max(0, Math.round(command.positionMs))}`)}`, undefined);
      case 'shuffle':
        return client.put(`/me/player/shuffle?${q(`state=${command.on}`)}`, undefined);
      case 'repeat':
        return client.put(`/me/player/repeat?${q(`state=${command.mode}`)}`, undefined);
      case 'start': {
        const body = command.album
          ? { context_uri: `spotify:album:${command.album}`, ...(command.track ? { offset: { uri: `spotify:track:${command.track}` } } : {}) }
          : { uris: [`spotify:track:${command.track}`] };
        return client.put(`/me/player/play?${q('')}`, body);
      }
    }
  };
  try {
    await send();
  } catch (error) {
    // Nothing active (Spotify not playing anywhere just now): wake a device and try once more.
    if (error instanceof SpotifyError && error.status === 404) {
      try {
        await send(await someDevice(client));
        return;
      } catch (again) {
        explain(again);
      }
    }
    explain(error);
  }
}
