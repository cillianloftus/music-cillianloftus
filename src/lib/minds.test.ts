import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';
import { changedMinds } from './minds';

let db: DatabaseSync;
const rate = (id: string, entity_id: string, gut_score: number, rated_at: string, user_id = 'u-owner') =>
  insert(db, 'rating', [{ id, user_id, entity_type: 'recording', entity_id, depth: 'gut', gut_score, rated_at }]);

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db); // gut scores on 1 Jan 2026: a1 9, a3 5, …
  (env as { DB: D1Database }).DB = d1(db);
});

describe('changedMinds', () => {
  it('finds a score that moved a long way when rated again weeks later', async () => {
    rate('later-a3', 'a3', 8, '2026-03-01T00:00:00.000Z'); // 50 → 80
    rate('later-a1', 'a1', 6, '2026-02-01T00:00:00.000Z'); // 90 → 60
    const minds = await changedMinds('u-owner');
    expect(minds.map((m) => [m.entity_id, m.title, Math.round(m.was), Math.round(m.now)])).toEqual([
      ['a3', 'Song A3', 50, 80],
      ['a1', 'Song A1', 90, 60],
    ]);
  });

  it('leaves out refining the same evening, however far it moves', async () => {
    rate('soon', 'a3', 9, '2026-01-01T03:00:00.000Z');
    expect(await changedMinds('u-owner')).toEqual([]);
  });

  it('leaves out small moves, and other people’s ratings', async () => {
    rate('small', 'a2', 7.5, '2026-03-01T00:00:00.000Z'); // 70 → 75
    rate('friend', 'b2', 1, '2026-03-01T00:00:00.000Z', 'u-friend');
    expect(await changedMinds('u-owner')).toEqual([]);
  });
});
