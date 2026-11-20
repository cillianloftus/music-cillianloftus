import { describe, expect, it } from 'vitest';
import { pickAlbum, type SpotifyTrackFound } from './played';
import { indexOf, matchTrack } from '../listens/match';
import { listenTrack } from '../listens/keys';

const track = (name: string, artist: string, album: Partial<SpotifyTrackFound['album']> & { id: string }): SpotifyTrackFound => ({
  id: `t-${album.id}`,
  name,
  artists: [{ name: artist }],
  album: { name: album.id, album_type: 'album', artists: [{ name: artist }], ...album },
});

describe('pickAlbum', () => {
  const want = listenTrack({ artist: 'Logic', title: 'Hit My Line' });

  it('takes the album over a single, the earliest album over a reissue', () => {
    const got = pickAlbum(want, [
      track('Hit My Line', 'Logic', { id: 'single', album_type: 'single', release_date: '2019-01-01' }),
      track('Hit My Line', 'Logic', { id: 'deluxe', release_date: '2021-06-01' }),
      track('Hit My Line', 'Logic', { id: 'original', release_date: '2020-03-01' }),
    ]);
    expect(got?.id).toBe('original');
  });

  it('never a compilation, nor another artist’s album, nor another song', () => {
    expect(
      pickAlbum(want, [
        track('Hit My Line', 'Logic', { id: 'now-thats', album_type: 'compilation' }),
        track('Hit My Line', 'Logic', { id: 'various', artists: [{ name: 'Various Artists' }] }),
        track('Hit My Line (Remix)', 'Logic', { id: 'remix' }),
        track('Hit My Line', 'Someone Else', { id: 'cover' }),
      ]),
    ).toBeNull();
  });

  it('matches with or without the guest named', () => {
    const got = pickAlbum(listenTrack({ artist: 'Logic', title: 'Hit My Line (feat. Someone)' }), [track('Hit My Line', 'Logic', { id: 'a' })]);
    expect(got?.id).toBe('a');
  });
});

describe('matchTrack and "feat."', () => {
  const index = indexOf([
    { id: 'r1', title: 'Hit My Line (feat. Someone)', mbid: null, spotify_id: null, length_ms: null, artists: JSON.stringify(['Logic']), albums: '[]' },
    { id: 'r2', title: 'Nasty', mbid: null, spotify_id: null, length_ms: null, artists: JSON.stringify(['Logic']), albums: '[]' },
  ]);

  it('finds a catalogue title naming the guest from a listen that does not', () => {
    expect(matchTrack(index, { artist: 'Logic', title: 'Hit My Line' })?.id).toBe('r1');
  });

  it('finds a catalogue title without the guest from a listen naming one', () => {
    expect(matchTrack(index, { artist: 'Logic', title: 'Nasty (feat. Someone)' })?.id).toBe('r2');
  });
});
