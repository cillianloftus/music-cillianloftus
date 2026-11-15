import { describe, expect, it } from 'vitest';
import type { Anomaly } from './review';
import { arrange } from './review-queue';

const item = (id: string, a: string, b: string | null = null, skipped: string | null = null): Anomaly => ({
  id,
  kind: 'near_duplicate_recording',
  entity_type: 'recording',
  entity_a: a,
  entity_b: b,
  detected_at: `2026-11-0${id.length}T00:00:00.000Z`,
  status: 'open',
  resolution: null,
  skipped_at: skipped,
});

const index = {
  x1: { t: 'Some Song', a: [['nobody', 'Nobody'] as [string, string]] },
  x2: { t: 'Under Pressure', a: [['logic', 'Logic'] as [string, string]] },
  x3: { t: 'Young Jesus', a: [['logic', 'Logic'] as [string, string]] },
  x4: { t: 'Hey Jude', a: [['beatles', 'The Beatles'] as [string, string]] },
};
const cares = { artists: { logic: 40, beatles: 5 }, rated: ['young-jesus'] };
const open = [item('x1', 'some'), item('x2', 'pressure'), item('x3', 'young-jesus'), item('x4', 'jude')];

describe('the review queue', () => {
  it('puts what you rated first, then the artists you rate most, then the rest', () => {
    expect(arrange(open, index, cares, {}, 10).items.map((a) => a.id)).toEqual(['x3', 'x2', 'x4', 'x1']);
  });

  it('keeps skipped items last', () => {
    const skipped = [item('x3', 'young-jesus', null, '2026-11-10T00:00:00.000Z'), ...open.filter((a) => a.id !== 'x3')];
    expect(arrange(skipped, index, cares, {}, 10).items.map((a) => a.id)).toEqual(['x2', 'x4', 'x1', 'x3']);
  });

  it('narrows to one artist, or by a search over titles and artists', () => {
    expect(arrange(open, index, cares, { artist: 'logic' }, 10)).toMatchObject({ matched: 2, artistName: 'Logic' });
    expect(arrange(open, index, cares, { q: 'beatles' }, 10).items.map((a) => a.id)).toEqual(['x4']);
    expect(arrange(open, index, cares, { q: 'young' }, 10).items.map((a) => a.id)).toEqual(['x3']);
  });

  it('offers pills for the artists most worth working through', () => {
    expect(arrange(open, index, cares, {}, 10).pills).toEqual([
      { id: 'logic', name: 'Logic', count: 2 },
      { id: 'beatles', name: 'The Beatles', count: 1 },
      { id: 'nobody', name: 'Nobody', count: 1 },
    ]);
  });
});
