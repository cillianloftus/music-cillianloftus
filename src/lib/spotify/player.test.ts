import { describe, expect, it } from 'vitest';
import { SpotifyError, type SpotifyClient } from './client';
import { control, PlayerError, toState } from './player';

const playback = {
  is_playing: true,
  progress_ms: 61_000,
  shuffle_state: false,
  repeat_state: 'off' as const,
  currently_playing_type: 'track' as const,
  device: { id: 'phone', name: 'Pixel 8', type: 'Smartphone', volume_percent: 70 },
  item: {
    id: 'x'.repeat(22),
    name: 'ice the bruise',
    duration_ms: 175_000,
    artists: [{ id: 'a', name: 'Dev Lemons' }],
    album: {
      id: 'y'.repeat(22),
      name: 'hunting what we already killed',
      images: [
        { url: 'small', width: 64 },
        { url: 'large', width: 640 },
      ],
    },
  },
};

/** A client that fails the first call with `first`, recording every call. */
function fakeClient(first?: SpotifyError, devices: unknown[] = [{ id: 'laptop', type: 'Computer', is_active: false, is_restricted: false }, { id: 'phone', type: 'Smartphone', is_active: false, is_restricted: false }]) {
  const calls: [string, string, unknown][] = [];
  let failed = false;
  const call = (method: string) => async (path: string, body?: unknown) => {
    calls.push([method, path, body]);
    if (path === '/me/player/devices') return { devices };
    if (first && !failed) {
      failed = true;
      throw first;
    }
    return undefined;
  };
  return { calls, client: { get: call('GET'), put: call('PUT'), post: call('POST') } as unknown as SpotifyClient };
}

describe('now playing', () => {
  it('reads Spotify’s playback into what the page needs, the largest cover first', () => {
    expect(toState(playback, 1000)).toEqual({
      playing: true,
      progressMs: 61_000,
      at: 1000,
      shuffle: false,
      repeat: 'off',
      device: { name: 'Pixel 8', type: 'Smartphone' },
      track: {
        spotifyId: 'x'.repeat(22),
        title: 'ice the bruise',
        artists: ['Dev Lemons'],
        artistIds: ['a'],
        album: 'hunting what we already killed',
        albumSpotifyId: 'y'.repeat(22),
        art: 'large',
        durationMs: 175_000,
      },
    });
    expect(toState(undefined)).toBeNull();
    expect(toState({ ...playback, currently_playing_type: 'episode' })!.track).toBeNull();
  });

  it('starts a track inside its album, so the album plays on', async () => {
    const { client, calls } = fakeClient();
    await control(client, { action: 'start', track: 't'.repeat(22), album: 'a'.repeat(22) });
    expect(calls).toEqual([['PUT', '/me/player/play?', { context_uri: `spotify:album:${'a'.repeat(22)}`, offset: { uri: `spotify:track:${'t'.repeat(22)}` } }]]);
  });

  it('wakes a phone when nothing is playing anywhere, and tries once more', async () => {
    const { client, calls } = fakeClient(new SpotifyError('no active device', 404));
    await control(client, { action: 'start', track: 't'.repeat(22) });
    expect(calls.map(([m, p]) => `${m} ${p}`)).toEqual(['PUT /me/player/play?', 'GET /me/player/devices', 'PUT /me/player/play?device_id=phone']);
  });

  it('says plainly why it cannot', async () => {
    await expect(control(fakeClient(new SpotifyError('Insufficient client scope', 403)).client, { action: 'next' })).rejects.toMatchObject({ reason: 'scope' });
    await expect(control(fakeClient(new SpotifyError('Player command failed: Premium required', 403)).client, { action: 'next' })).rejects.toMatchObject({ reason: 'premium' });
    await expect(control(fakeClient(new SpotifyError('no device', 404), []).client, { action: 'play' })).rejects.toBeInstanceOf(PlayerError);
  });
});
