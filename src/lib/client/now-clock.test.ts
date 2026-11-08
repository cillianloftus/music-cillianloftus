import { describe, expect, it } from 'vitest';
import type { NowState } from '../spotify/now-state';
import { NowClock, type Track } from './now-clock';

const track = (id: string, durationMs = 200_000): Track => ({
  spotifyId: id.padEnd(22, '0'),
  title: id,
  artists: ['Someone'],
  artistIds: ['a'],
  album: 'Album',
  albumSpotifyId: 'b'.repeat(22),
  art: null,
  durationMs,
});

const state = (over: Partial<NowState> = {}): NowState => ({
  playing: true,
  progressMs: 10_000,
  at: 1_000_000,
  shuffle: false,
  repeat: 'off',
  device: null,
  track: track('one'),
  ...over,
});

describe('NowClock', () => {
  it('counts on from the last answer while playing, and stops when paused', () => {
    const clock = new NowClock(state());
    expect(clock.position(1_005_000)).toBe(15_000);
    clock.accept(state({ playing: false, progressMs: 15_000, at: 1_005_000 }), 1_005_000);
    expect(clock.position(1_009_000)).toBe(15_000);
  });

  it('does not snap to an answer that nearly agrees, so the bar never twitches', () => {
    const clock = new NowClock(state());
    // Spotify says 300ms behind the local count: keep counting as before.
    clock.accept(state({ progressMs: 14_700, at: 1_005_000 }), 1_005_000);
    expect(clock.position(1_005_000)).toBe(15_000);
    // Two seconds out (seeked in Spotify's own app): follow it.
    clock.accept(state({ progressMs: 40_000, at: 1_006_000 }), 1_006_000);
    expect(clock.position(1_006_000)).toBe(40_000);
  });

  it('keeps a pause made here while Spotify catches up', () => {
    const clock = new NowClock(state());
    clock.set({ playing: false }, 1_002_000);
    // A stale answer half a second later still says playing.
    clock.accept(state({ playing: true, progressMs: 12_500, at: 1_002_500 }), 1_002_500);
    expect(clock.state?.playing).toBe(false);
    expect(clock.position(1_004_000)).toBe(12_000);
    // Once the hold is over, Spotify's word stands.
    clock.accept(state({ playing: true, progressMs: 30_000, at: 1_010_000 }), 1_010_000);
    expect(clock.state?.playing).toBe(true);
  });

  it('moves on to the queued song at the end, and ignores answers still naming the old one', () => {
    const clock = new NowClock(state({ progressMs: 199_000, next: track('two') }));
    expect(clock.ended(1_000_500)).toBe(false);
    expect(clock.ended(1_001_200)).toBe(true);
    expect(clock.advance(1_001_200)).toBe(true);
    expect(clock.state?.track?.title).toBe('two');
    // The 200ms run past the end counts towards the new song.
    expect(clock.position(1_001_200)).toBe(200);
    // Spotify hasn't switched yet: not shown.
    expect(clock.accept(state({ progressMs: 200_000, at: 1_001_600 }), 1_001_600)).toBe(false);
    expect(clock.state?.track?.title).toBe('two');
    // Now it has.
    clock.accept(state({ track: track('two'), progressMs: 1_200, at: 1_002_000 }), 1_002_000);
    expect(clock.state?.track?.title).toBe('two');
  });

  it('follows Spotify if it played something other than the guess', () => {
    const clock = new NowClock(state({ progressMs: 199_900, next: track('two') }));
    clock.advance(1_000_200);
    expect(clock.accept(state({ track: track('three'), progressMs: 500, at: 1_001_000 }), 1_001_000)).toBe(true);
    expect(clock.state?.track?.title).toBe('three');
  });

  it('starts the same song again on repeat-one', () => {
    const clock = new NowClock(state({ progressMs: 199_900, repeat: 'track', next: track('two') }));
    expect(clock.advance(1_000_200)).toBe(false);
    expect(clock.state?.track?.title).toBe('one');
    expect(clock.position(1_000_200)).toBe(0);
  });

  it('keeps the known queue when an answer comes without it', () => {
    const clock = new NowClock(state({ next: track('two') }));
    clock.accept(state({ at: 1_001_000, progressMs: 11_000 }), 1_001_000);
    expect(clock.state?.next?.title).toBe('two');
  });
});
