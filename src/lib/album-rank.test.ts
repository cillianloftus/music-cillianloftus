import { describe, expect, it } from 'vitest';
import { byRank, rankScore, type AlbumScores } from './album-scores';

describe('album ranking', () => {
  it('ranks a fully rated 97 above a 100 on one song of twelve', () => {
    const full = rankScore(97, 12, 12, 70);
    const one = rankScore(100, 1, 12, 70);
    expect(full).toBe(97);
    expect(one).toBeCloseTo(78.7, 1);
    expect(full).toBeGreaterThan(one);
  });

  it('counts an album rated only as a whole as half rated, and an unknown length as complete', () => {
    expect(rankScore(90, 0, 10, 70)).toBeCloseTo(70 + 20 * Math.SQRT1_2);
    expect(rankScore(90, 3, null, 70)).toBe(90);
  });

  it('orders by rank, then score, then id', () => {
    const a = (rank: number, quality: number) => ({ quality, personal: quality, rated: 1, tracks: 1, type: 'album', released: null, rank });
    const scores: AlbumScores = { x: a(80, 90), y: a(85, 85), z: a(80, 95) };
    expect(['x', 'y', 'z'].sort(byRank(scores))).toEqual(['y', 'z', 'x']);
  });
});
