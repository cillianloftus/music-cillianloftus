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

type ApiTrack = NonNullable<ApiPlayback['item']>;

function toTrack(item: ApiTrack): NonNullable<NowState['track']> {
  return {
    spotifyId: item.id,
    title: item.name,
    artists: item.artists.map((a) => a.name),
    artistIds: item.artists.map((a) => a.id),
    album: item.album.name,
    albumSpotifyId: item.album.id,
    art: [...item.album.images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? null,
    durationMs: item.duration_ms,
  };
}

export function toState(p: ApiPlayback | undefined, now = Date.now()): NowState | null {
  if (!p) return null;
  const item = p.currently_playing_type === 'track' ? p.item : null;
  return {
    playing: p.is_playing,
    progressMs: p.progress_ms ?? 0,
    at: now,
    shuffle: p.shuffle_state,
    repeat: p.repeat_state,
    device: p.device ? { name: p.device.name, type: p.device.type } : null,
    track: item ? toTrack(item) : null,
  };
}

/**
 * The song Spotify will play next, from its queue (which already follows
 * shuffle, repeat and autoplay), so the page can move on the moment the
 * current one ends instead of waiting for the next poll.
 */
export async function upNext(client: SpotifyClient): Promise<NowState['track']> {
  try {
    const { queue } = await client.get<{ queue: (ApiTrack & { type: string })[] }>('/me/player/queue');
    const next = queue.find((q) => q.type === 'track');
    return next ? toTrack(next) : null;
  } catch {
    // Only a guess; the poll still tells the truth.
    return null;
  }
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
  | { action: 'start'; track?: string; album?: string }
  /** A track after the one playing (long-press, Add to queue). */
  | { action: 'queue'; track: string };

/** What kind of device the command was sent from, so the music starts there. */
export type Origin = 'phone' | 'computer';

const KIND: Record<Origin, string> = { phone: 'Smartphone', computer: 'Computer' };

type Device = { id: string | null; type: string; is_active: boolean; is_restricted: boolean };

/**
 * The device to play on: one like the one the command came from (a tap on
 * the phone plays on the phone), else the active one, else a phone, else
 * whatever Spotify lists first.
 */
async function someDevice(client: SpotifyClient, from?: Origin): Promise<string> {
  const { devices } = await client.get<{ devices: Device[] }>('/me/player/devices');
  const usable = devices.filter((d) => d.id && !d.is_restricted);
  const pick =
    (from && usable.find((d) => d.type === KIND[from])) ??
    usable.find((d) => d.is_active) ??
    usable.find((d) => d.type === 'Smartphone') ??
    usable[0];
  if (!pick) throw new PlayerError('Open Spotify on your phone or computer first, so there is somewhere to play.', 'no-device');
  return pick.id!;
}

/**
 * Where a start (or a play from paused) should go. Music already playing
 * stays where it is: someone listening on the TV meant to. Otherwise
 * Spotify left to itself resumes on the last device used (the living room
 * TV, often), so the device the command came from is named instead.
 */
async function target(client: SpotifyClient, from: Origin | undefined): Promise<string | undefined> {
  if (!from) return undefined;
  const playback = await client.get<{ is_playing?: boolean } | undefined>('/me/player').catch(() => undefined);
  if (playback?.is_playing) return undefined;
  return someDevice(client, from).catch(() => undefined);
}

/**
 * The album a Spotify track is on, so one song started plays on through its
 * album rather than stopping when it ends (17 Nov). Undefined if Spotify
 * cannot say: the song alone, as before.
 */
async function albumOf(client: SpotifyClient, track: string): Promise<string | undefined> {
  const found = await client.get<{ album?: { id?: string } } | undefined>(`/tracks/${track}`).catch(() => undefined);
  return found?.album?.id ?? undefined;
}

export async function control(client: SpotifyClient, command: PlayerCommand, from?: Origin): Promise<void> {
  // A song started on its own plays inside its album (looked up once, not on each try).
  const album = command.action === 'start' ? (command.album ?? (command.track ? await albumOf(client, command.track) : undefined)) : undefined;
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
      case 'queue':
        return client.post(`/me/player/queue?${q(`uri=${encodeURIComponent(`spotify:track:${command.track}`)}`)}`, undefined);
      case 'start': {
        const body = album
          ? { context_uri: `spotify:album:${album}`, ...(command.track ? { offset: { uri: `spotify:track:${command.track}` } } : {}) }
          : { uris: [`spotify:track:${command.track}`] };
        return client.put(`/me/player/play?${q('')}`, body);
      }
    }
  };
  const starting = command.action === 'start' || command.action === 'play';
  try {
    await send(starting ? await target(client, from) : undefined);
  } catch (error) {
    // Nothing active (Spotify not playing anywhere just now): wake a device and try once more.
    if (error instanceof SpotifyError && error.status === 404) {
      try {
        await send(await someDevice(client, from));
        return;
      } catch (again) {
        explain(again);
      }
    }
    explain(error);
  }
}
