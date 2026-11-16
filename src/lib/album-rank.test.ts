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

  it('puts a fully considered album above one scored about the same mostly by gut, and never lowers one', () => {
    // I Didn't Mean To Haunt You: every song in full. Ants From Up There: two of ten.
    const haunt = rankScore(97.5, 11, 11, 80, 1);
    const ants = rankScore(97.9, 10, 10, 80, 0.2);
    expect(haunt).toBeGreaterThan(ants);
    expect(ants).toBeGreaterThanOrEqual(97.9);
    // Not past one clearly higher: a 99 by gut still ranks above a considered 97.5.
    expect(rankScore(99, 10, 10, 80, 0)).toBeGreaterThan(haunt);
  });

  it('orders by rank, then score, then id', () => {
    const a = (rank: number, quality: number) => ({ quality, personal: quality, rated: 1, tracks: 1, type: 'album', released: null, rank, own: true });
    const scores: AlbumScores = { x: a(80, 90), y: a(85, 85), z: a(80, 95) };
    expect(['x', 'y', 'z'].sort(byRank(scores))).toEqual(['y', 'z', 'x']);
  });
});

describe('the rating scale', () => {
  it('names each band as scores are meant', async () => {
    const { scoreWord, scoreHue } = await import('./format');
    expect([55, 65, 70, 85, 90, 99, 100, 106].map(scoreWord)).toEqual(['meh', 'like', 'enjoy', 'great', 'amazing', 'amazing', 'perfect', 'perfect']);
    expect([0, 9, 10, 25, 30, 42, 49].map(scoreWord)).toEqual(['can’t stand', 'can’t stand', 'hate', 'awful', 'bad', 'dislike', 'dislike']);
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
