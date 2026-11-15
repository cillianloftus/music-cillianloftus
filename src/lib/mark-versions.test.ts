import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';
import { markSame, markVersion, versionCandidates } from './mark-versions';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
  // A remix of the rated a2 (no work yet), by the same artist.
  insert(db, 'recording', [{ id: 'rx', title: 'Song A2 (Club Remix)', source: 'manual' }]);
  insert(db, 'artist_credit', [{ id: 'c-rx', entity_type: 'recording', entity_id: 'rx', artist_id: 'art-x', role: 'primary' }]);
});

const work = (id: string) => (db.prepare(`SELECT work_id FROM recording WHERE id = ?`).get(id) as { work_id: string | null }).work_id;
const score = (id: string) => db.prepare(`SELECT quality_score q, inherited FROM v_recording_score WHERE recording_id = ? AND user_id = 'u-owner'`).get(id);

describe('marking versions by hand', () => {
  it('offers the artist’s songs that are the same song once version words are set aside', async () => {
    expect((await versionCandidates('rx')).map((c) => c.id)).toEqual(['a2']);
  });

  it('makes them one song, and the unrated one takes the rated one’s score', async () => {
    await markVersion('rx', 'a2');
    expect(work('rx')).not.toBeNull();
    expect(work('rx')).toBe(work('a2'));
    expect(score('rx')).toMatchObject({ inherited: 1 });
    // Already linked: no longer offered.
    expect(await versionCandidates('rx')).toEqual([]);
  });

  it('brings the rest of each one’s work along', async () => {
    // a1 and c1 share w-a1; marking a2 a version of a1 puts a2 on it too.
    await markVersion('a2', 'a1');
    expect(work('a2')).toBe('w-a1');
    expect(work('c1')).toBe('w-a1');
  });

  it('merges the same recording entered twice', async () => {
    const kept = await markSame('rx', 'a2');
    expect(kept).toBe('a2');
    expect(db.prepare(`SELECT count(*) n FROM recording WHERE id = 'rx'`).get()).toEqual({ n: 0 });
  });
});
