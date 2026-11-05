import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';
import { genreArtists } from './pages';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

describe('genreArtists', () => {
  it('ranks artists by their rated tracks in the genre, with their own average', async () => {
    // Indie pop is Album A's genre: art-x's a1–a4, gut 9, 7, 5, 10.
    const artists = await genreArtists('g-indie', 'u-owner');
    expect(artists.map((a) => a.id)).toEqual(['art-x']);
    expect(artists[0]!.rated).toBe(4);
    expect(artists[0]!.average).toBeCloseTo(77.5);
  });

  it('takes in subgenres when asked', async () => {
    // Bedroom pop (under indie pop) adds Album B's b1; b2 is hand-tagged rock instead.
    expect((await genreArtists('g-indie', 'u-owner', 8, true))[0]!.rated).toBe(5);
  });

  it('leaves out an artist with a single rated track there', async () => {
    // art-y has one rated rock track (c1); art-x has b2 there too, but only one.
    expect(await genreArtists('g-rock', 'u-owner')).toEqual([]);
  });

  it('orders by the weighted score and shows each artist’s own average', async () => {
    // A newcomer with two perfect tracks against art-x's four averaging 77.5:
    // pulled toward the genre's mean, two 100s still lead, and still show as 100.
    insert(db, 'artist', [{ id: 'art-new', name: 'Newcomer', sort_name: 'Newcomer', source: 'manual' }]);
    insert(db, 'recording', [
      { id: 'n1', title: 'N1', source: 'manual' },
      { id: 'n2', title: 'N2', source: 'manual' },
    ]);
    insert(db, 'genre_tag', [
      { entity_type: 'recording', entity_id: 'n1', genre_id: 'g-indie', source: 'manual', weight: 1 },
      { entity_type: 'recording', entity_id: 'n2', genre_id: 'g-indie', source: 'manual', weight: 1 },
    ]);
    insert(db, 'artist_credit', [
      { id: 'cn1', entity_type: 'recording', entity_id: 'n1', artist_id: 'art-new', role: 'primary' },
      { id: 'cn2', entity_type: 'recording', entity_id: 'n2', artist_id: 'art-new', role: 'primary' },
    ]);
    insert(db, 'rating', [
      { id: 'rn1', user_id: 'u-owner', entity_type: 'recording', entity_id: 'n1', depth: 'gut', gut_score: 10, rated_at: '2026-02-01T00:00:00.000Z' },
      { id: 'rn2', user_id: 'u-owner', entity_type: 'recording', entity_id: 'n2', depth: 'gut', gut_score: 10, rated_at: '2026-02-01T00:00:01.000Z' },
    ]);
    const artists = await genreArtists('g-indie', 'u-owner');
    expect(artists.map((a) => a.id)).toEqual(['art-new', 'art-x']);
    expect(artists[0]!.average).toBe(100);
  });
});
