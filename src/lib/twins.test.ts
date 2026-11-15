import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';
import { findTwins, mergeTwins } from './twins';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
  // a1 is rated (seedLibrary). Its single's copy: the same work and title, a tenth of a second apart.
  db.exec(`UPDATE recording SET length_ms = 217620 WHERE id = 'a1'`);
  insert(db, 'release_group', [{ id: 'rg-s', title: 'Song A1', type: 'single', source: 'manual' }]);
  insert(db, 'release', [{ id: 'r-s', release_group_id: 'rg-s', title: 'Song A1', source: 'manual' }]);
  insert(db, 'recording', [
    { id: 's1', title: 'Song A1', work_id: 'w-a1', length_ms: 217553, source: 'manual' },
    // The same song live: a different title, so never a twin.
    { id: 's2', title: 'Song A1 (Live)', work_id: 'w-a1', length_ms: 217600, source: 'manual' },
  ]);
  insert(db, 'track', [
    { id: 't-s1', release_id: 'r-s', recording_id: 's1', position: 1 },
    { id: 't-s2', release_id: 'r-s', recording_id: 's2', position: 2 },
  ]);
});

const trackOn = (id: string) => (db.prepare(`SELECT recording_id FROM track WHERE id = ?`).get(id) as { recording_id: string }).recording_id;

describe('twin recordings', () => {
  it('are found: same work, same title, the same length', async () => {
    expect(await findTwins(null)).toEqual([['a1', 's1']]);
    expect(await findTwins(['s1'])).toEqual([['s1', 'a1']]);
  });

  it('become one song, the rated one kept, so the single shows its rating', async () => {
    expect(await mergeTwins({ budgetMs: 5_000, of: ['s1', 's2'] })).toBe(1);
    expect(trackOn('t-s1')).toBe('a1');
    expect(trackOn('t-s2')).toBe('s2');
    expect(await findTwins(null)).toEqual([]);
  });

  it('are left alone once judged different', async () => {
    db.exec(`INSERT INTO confirmed_distinct (entity_type, id_a, id_b) VALUES ('recording', 'a1', 's1')`);
    expect(await mergeTwins({ budgetMs: 5_000 })).toBe(0);
    expect(trackOn('t-s1')).toBe('s1');
  });
});
