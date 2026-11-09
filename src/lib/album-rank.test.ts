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

describe('the rating scale', () => {
  it('names each band as scores are meant', async () => {
    const { scoreWord, scoreHue } = await import('./format');
    expect([45, 50, 65, 70, 85, 90].map(scoreWord)).toEqual(['don’t like', 'okay', 'like', 'enjoy', 'great', 'amazing']);
    // Red to orange below 50, a neutral yellow at 50 to 60, green from 70.
    expect(scoreHue(30)).toBeLessThan(45);
    expect(scoreHue(55)).toBeGreaterThan(80);
    expect(scoreHue(55)).toBeLessThan(100);
    expect(scoreHue(70)).toBeGreaterThan(115);
  });

  it('pulls uncertain ranks toward halfway between 70 and the average', async () => {
    const { rankAnchor } = await import('./rank-anchor');
    expect(rankAnchor(86)).toBe(78);
    expect(rankAnchor(null)).toBe(70);
  });
});
