import { describe, expect, it } from 'vitest';
import { hasShape, shapeOf } from './shape';

describe('shapeOf', () => {
  it('sees a front-loaded album', () => {
    const shape = shapeOf([92, 90, 88, 80, 79, 81, 72, 70, 74]);
    expect(shape.verdict).toBe('front');
    expect(shape.words).toBe('Strongest at the start: the first third averages 90, the last 72.');
  });

  it('sees one that finishes strongest', () => {
    expect(shapeOf([70, 72, 75, 78, 80, 79, 90, 92, 91]).verdict).toBe('back');
  });

  it('sees a peak and a sag in the middle', () => {
    expect(shapeOf([75, 74, 90, 92, 91, 76, 73, 75]).verdict).toBe('peak');
    expect(shapeOf([90, 88, 70, 72, 71, 70, 89, 91]).verdict).toBe('sag');
  });

  it('calls differences within the margin even, and says nothing', () => {
    const shape = shapeOf([85, 82, 84, 86, 83, 85, 84, 82, 86]);
    expect(shape.verdict).toBe('even');
    expect(shape.words).toBeNull();
  });

  it('gives a remainder to the middle so the ends are the same size', () => {
    // 7 tracks: 2, 3, 2.
    const shape = shapeOf([100, 100, 50, 50, 50, 0, 0]);
    expect(shape.thirds).toEqual([100, 50, 0]);
  });

  it('averages only the rated tracks in a third', () => {
    expect(shapeOf([90, null, 80, 80, null, 70]).thirds).toEqual([90, 80, 70]);
  });
});

describe('hasShape', () => {
  it('needs six tracks, two-thirds rated, something in every third', () => {
    expect(hasShape([90, 80, 70, 60, 50])).toBe(false);
    expect(hasShape([90, 80, null, null, null, 70])).toBe(false);
    expect(hasShape([90, 80, 85, null, 75, 70])).toBe(true);
    expect(hasShape([null, null, 85, 80, 75, 70])).toBe(false);
  });
});
