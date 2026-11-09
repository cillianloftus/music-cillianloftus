import { describe, expect, it } from 'vitest';
import type { TrackFact } from './discover';
import { hiddenGems, medianListeners, tempoBands } from './insights-crowd';

const fact = (id: string, score: number, bpm: number | null, listeners: number | null) =>
  ({ id, title: id, score, bpm, listeners, credits: [] }) as unknown as TrackFact;

describe('tempo and the crowd', () => {
  it('averages scores by tempo band, leaving out empty bands', () => {
    const bands = tempoBands([fact('a', 90, 160, null), fact('b', 70, 160, null), fact('c', 60, 85, null), fact('d', 99, null, null)]);
    expect(bands.map((b) => [b.key, b.count, b.average])).toEqual([
      ['slow', 1, 60],
      ['fast', 2, 80],
    ]);
  });

  it('finds the best-rated tracks few people listen to, and the middle listener count', () => {
    const facts = [fact('gem', 95, null, 300), fact('known', 99, null, 90000), fact('meh', 60, null, 100), fact('gem2', 90, null, 1500)];
    expect(hiddenGems(facts).map((f) => f.id)).toEqual(['gem', 'gem2']);
    expect(medianListeners(facts)).toBeNull();
    const many = Array.from({ length: 11 }, (_, i) => fact(`t${i}`, 80, null, (i + 1) * 100));
    expect(medianListeners(many)).toEqual({ median: 600, known: 11 });
  });
});
