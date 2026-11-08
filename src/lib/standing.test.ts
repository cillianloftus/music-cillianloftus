import { describe, expect, it } from 'vitest';
import type { TrackFact } from './discover';
import { albumStanding, standing, type AlbumScore } from './standing';

const fact = (id: string, score: number, extra: Partial<TrackFact> = {}): TrackFact => ({
  id,
  title: id,
  score,
  ratedAt: null,
  lengthMs: null,
  albumId: 'al',
  albumTitle: 'The Album',
  albumType: 'album',
  released: '2020-01-01',
  position: null,
  size: null,
  extra: false,
  label: null,
  credits: [{ id: 'ar', name: 'The Artist', role: 'primary', label: 'Artist', family: 'artist', position: 1, born: null }],
  genres: [],
  plays: 0,
  axes: { arrangement: null, sound: null, songwriting: null, lyrics: null, performance: null },
  gut: null,
  ...extra,
});

describe('standing', () => {
  it('names a clear favourite', () => {
    const facts = [fact('a', 95), fact('b', 80), fact('c', 70), fact('d', 60), fact('e', 50)];
    expect(standing(facts, 'a').map((s) => s.text)).toEqual([
      'Your favourite of 5 rated on The Album',
      'Your favourite The Artist track, of 5',
      'Your favourite from 2020',
    ]);
  });

  it('says nothing about a top place shared by many', () => {
    const facts = [...Array.from({ length: 6 }, (_, i) => fact(`t${i}`, 100)), fact('low', 50)];
    expect(standing(facts, 't0').some((s) => /favourite/.test(s.text))).toBe(false);
  });

  it('counts ties against a track when giving a percentage', () => {
    const facts = Array.from({ length: 40 }, (_, i) => fact(`t${i}`, i < 4 ? 100 : 50, { albumId: `al${i}`, credits: [] }));
    expect(standing(facts, 't0').map((s) => s.text)).toContain('In the top 10% of the 40 tracks you’ve rated');
    const crowded = Array.from({ length: 40 }, (_, i) => fact(`t${i}`, i < 10 ? 100 : 50, { albumId: `al${i}`, credits: [] }));
    expect(standing(crowded, 't0').some((s) => s.text.startsWith('In the top'))).toBe(false);
  });

  it('notices the gut and the considered score parting', () => {
    const facts = [fact('a', 90, { gut: 70 }), fact('b', 80), fact('c', 70)];
    expect(standing(facts, 'a').map((s) => s.text)).toContain('Your gut said 70; thinking it through made it 90');
  });
});

describe('album standing', () => {
  const album = (id: string, score: number, extra: Partial<AlbumScore> = {}): AlbumScore => ({
    id,
    score,
    type: 'album',
    year: '2020',
    artists: ['ar'],
    artistNames: ['The Artist'],
    ...extra,
  });

  it('places an album among its kind, its artist and its year', () => {
    const albums = [album('a', 95), album('b', 90), album('c', 80, { artists: ['other'] }), album('d', 70, { artists: ['other'] }), album('e', 60, { year: '2019' }), album('s', 99, { type: 'single' })];
    expect(albumStanding(albums, 'a').map((l) => l.text)).toEqual([
      'Your favourite album, of 5',
      'Your favourite The Artist album, of 3',
      'Your favourite album of 2020',
    ]);
    // A higher-scoring single doesn't count against an album.
    expect(albumStanding(albums, 'e').map((l) => l.text)).toContain('Your least favourite The Artist album');
  });
});
