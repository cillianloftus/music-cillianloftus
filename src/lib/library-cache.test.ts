import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';
import { libraryStamp } from './library-cache';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
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
      expect(await libraryStamp('u-owner')).not.toBe(before);
    });
  }

  it('ignores another user’s ratings', async () => {
    const before = await libraryStamp('u-owner');
    insert(db, 'rating', [{ id: 'f2', user_id: 'u-friend', entity_type: 'recording', entity_id: 'a1', depth: 'gut', gut_score: 3, rated_at: '2026-03-01T00:00:00.000Z' }]);
    expect(await libraryStamp('u-owner')).toBe(before);
  });
});
