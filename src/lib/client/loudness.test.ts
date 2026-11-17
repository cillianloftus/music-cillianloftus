import { describe, expect, it } from 'vitest';
import { gatedLoudness } from './loudness';
import { levelFor } from './local-player';

// Energy of a tenth of a second of a steady signal with mean square ms, over n samples.
const steady = (ms: number, tenths: number, n = 4410) => Array.from({ length: tenths }, () => ms * n);

describe('loudness, as BS.1770 measures it', () => {
  it('reads a steady full-scale tone at about -3.7 LUFS (mean square one half)', () => {
    expect(gatedLoudness(steady(0.5, 50), 4410)).toBe(-3.7);
  });

  it('leaves silence and quiet passages out of the average', () => {
    const loud = steady(0.05, 40);
    const withGaps = [...loud, ...steady(0, 40), ...steady(0.05 / 1000, 40), ...loud];
    // Within half a decibel: the blocks straddling each edge are partly loud, and count, as the standard has it.
    expect(Math.abs(gatedLoudness(withGaps, 4410)! - gatedLoudness(loud, 4410)!)).toBeLessThan(0.5);
  });

  it('has nothing to say about silence', () => {
    expect(gatedLoudness(steady(0, 30), 4410)).toBeNull();
  });
});

describe('playing your files at Spotify’s level', () => {
  it('turns a loud master down to -14 LUFS and never turns a quiet one up', () => {
    expect(levelFor(-8)).toBeCloseTo(0.501, 2);
    expect(levelFor(-14)).toBe(1);
    expect(levelFor(-20)).toBe(1);
    expect(levelFor(null)).toBe(1);
  });
});
