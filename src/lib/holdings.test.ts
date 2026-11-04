import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { migratedDb, seedLibrary } from '../test/db';
import { addHolding, holdingInput, holdingsFor, removeHolding } from './holdings';
import { compile } from './query/compile';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

const input = (overrides: Record<string, string> = {}) => holdingInput.parse({ release_id: 'r-a-deluxe', format: 'vinyl', ...overrides });

describe('holdings', () => {
  it('records an edition owned, with a partial date', async () => {
    expect(await addHolding('u-owner', input({ acquired: '2019-06', notes: 'Signed' }))).toBe('rg-a');
    expect(await holdingsFor('u-owner', 'rg-a')).toEqual([
      expect.objectContaining({ release_id: 'r-a-deluxe', format: 'vinyl', acquired_at: '2019-06', date_precision: 'month', notes: 'Signed' }),
    ]);
    expect(await holdingsFor('u-friend', 'rg-a')).toEqual([]);
  });

  it('rejects an unknown edition, format or date', async () => {
    expect(await addHolding('u-owner', input({ release_id: 'nope' }))).toBeNull();
    expect(holdingInput.safeParse({ release_id: 'r-a', format: 'minidisc' }).success).toBe(false);
    expect(holdingInput.safeParse({ release_id: 'r-a', format: 'cd', acquired: 'last summer' }).success).toBe(false);
  });

  it('removes only the user’s own', async () => {
    await addHolding('u-owner', input());
    const [held] = await holdingsFor('u-owner', 'rg-a');
    expect(await removeHolding('u-friend', held!.id)).toBeNull();
    expect(await removeHolding('u-owner', held!.id)).toBe('rg-a');
    expect(await holdingsFor('u-owner', 'rg-a')).toEqual([]);
  });

  it('makes the owned filter true for the album', async () => {
    await addHolding('u-owner', input());
    const { sql, params } = compile({ entity: 'release_group', where: { field: 'owned', op: 'eq', value: true }, collapse_by_work: true, limit: 50 }, { userId: 'u-owner' });
    const ids = (db.prepare(sql).all(...(params as never[])) as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(['rg-a']);
  });
});
