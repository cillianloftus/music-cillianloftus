import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';
import { forgetLibraryStamp, libraryStamp } from './library-cache';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
  forgetLibraryStamp();
});

describe('libraryStamp', () => {
  it('holds while nothing changes', async () => {
    expect(await libraryStamp('u-owner')).toBe(await libraryStamp('u-owner'));
  });

  const changes: Array<[string, () => void]> = [
    ['a rating', () => insert(db, 'rating', [{ id: 'new', user_id: 'u-owner', entity_type: 'recording', entity_id: 'a1', depth: 'gut', gut_score: 3, rated_at: '2026-02-01T00:00:00.000Z' }])],
    ['a new credit', () => insert(db, 'artist_credit', [{ id: 'c-new', entity_type: 'recording', entity_id: 'c1', artist_id: 'art-x', role: 'featured' }])],
    ['a genre tag', () => insert(db, 'genre_tag', [{ entity_type: 'recording', entity_id: 'a1', genre_id: 'g-rock', source: 'manual', weight: 1 }])],
    ['a hand edit', () => insert(db, 'field_override', [{ entity_type: 'artist', entity_id: 'art-x', field: 'name', value_json: '"Renamed"', user_id: 'u-owner', edited_at: '2026-02-01T00:00:00.000Z' }])],
    ['a cover found later', () => db.exec(`UPDATE release SET art_key = 'art/release/r-a/cover.jpg' WHERE id = 'r-a'`)],
  ];
  for (const [what, change] of changes) {
    it(`moves with ${what}`, async () => {
      const before = await libraryStamp('u-owner');
      change();
      forgetLibraryStamp();
      expect(await libraryStamp('u-owner')).not.toBe(before);
    });
  }

  it('moves with anyone’s rating: one seek, where counting one user’s read them all', async () => {
    const before = await libraryStamp('u-owner');
    insert(db, 'rating', [{ id: 'f2', user_id: 'u-friend', entity_type: 'recording', entity_id: 'a1', depth: 'gut', gut_score: 3, rated_at: '2026-03-01T00:00:00.000Z' }]);
    forgetLibraryStamp();
    expect(await libraryStamp('u-owner')).not.toBe(before);
  });

  it('moves when a picture is hidden, which changes no count of rows', async () => {
    insert(db, 'artist_image', [{ id: 'i1', artist_id: 'art-x', key: 'art/artist/art-x/1.jpg', source: 'manual', position: 0 }]);
    const before = await libraryStamp('u-owner');
    db.exec(`UPDATE artist_image SET hidden = 1 WHERE id = 'i1'`);
    forgetLibraryStamp();
    expect(await libraryStamp('u-owner')).not.toBe(before);
  });

  it('holds for values that are no one’s when someone rates', async () => {
    const before = await libraryStamp(null);
    insert(db, 'rating', [{ id: 'f3', user_id: 'u-owner', entity_type: 'recording', entity_id: 'a1', depth: 'gut', gut_score: 3, rated_at: '2026-03-01T00:00:00.000Z' }]);
    forgetLibraryStamp();
    expect(await libraryStamp(null)).toBe(before);
  });

  it('is remembered briefly, and forgotten after a write', async () => {
    const first = await libraryStamp('u-owner', 1_000);
    insert(db, 'rating', [{ id: 'n3', user_id: 'u-owner', entity_type: 'recording', entity_id: 'a1', depth: 'gut', gut_score: 3, rated_at: '2026-04-01T00:00:00.000Z' }]);
    expect(await libraryStamp('u-owner', 5_000)).toBe(first);
    expect(await libraryStamp('u-owner', 20_000)).not.toBe(first);
  });
});
