import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';
import { rebuildInheritedScores } from './inherited';
import { computeScores, DEFAULT_WEIGHTS } from './scoring';
import { scoreInputs } from './weights';

let db: DatabaseSync;

beforeEach(async () => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
  // a1 is rated. A remix of it by the same artist, on a single of its own; c1 is someone else's cover.
  insert(db, 'release_group', [{ id: 'rg-r', title: 'Song A1 (Remix)', type: 'single', source: 'manual' }]);
  insert(db, 'release', [{ id: 'r-r', release_group_id: 'rg-r', title: 'Song A1 (Remix)', source: 'manual' }]);
  insert(db, 'recording', [{ id: 'rx', title: 'Song A1 (Remix)', work_id: 'w-a1', source: 'manual' }]);
  insert(db, 'track', [{ id: 't-rx', release_id: 'r-r', recording_id: 'rx', position: 1 }]);
  insert(db, 'artist_credit', [{ id: 'c-rx', entity_type: 'recording', entity_id: 'rx', artist_id: 'art-x', role: 'primary' }]);
  await rebuildInheritedScores('u-owner');
});

const score = (id: string) =>
  (db.prepare(`SELECT quality_score q, inherited FROM v_recording_score WHERE recording_id = ? AND user_id = 'u-owner'`).get(id) as
    | { q: number; inherited: number }
    | undefined);

describe('versions sharing a score', () => {
  it('give an unrated version of a rated song its score', () => {
    expect(score('rx')).toEqual({ q: score('a1')!.q, inherited: 1 });
  });

  it('never give it to someone else’s cover', async () => {
    // A third artist's: art-y's own rated cover (c1) would rightly lend art-y's versions its score.
    insert(db, 'artist', [{ id: 'art-z', name: 'Zed', sort_name: 'Zed', source: 'manual' }]);
    insert(db, 'recording', [{ id: 'cv', title: 'Song A1', work_id: 'w-a1', source: 'manual' }]);
    insert(db, 'artist_credit', [{ id: 'c-cv', entity_type: 'recording', entity_id: 'cv', artist_id: 'art-z', role: 'primary' }]);
    await rebuildInheritedScores('u-owner');
    expect(score('cv')).toBeUndefined();
  });

  it('give way to the version’s own rating at once', () => {
    insert(db, 'rating', [{ id: 'own', user_id: 'u-owner', entity_type: 'recording', entity_id: 'rx', depth: 'gut', gut_score: 3, rated_at: '2026-06-01T00:00:00.000Z' }]);
    expect(score('rx')).toMatchObject({ inherited: 0 });
    expect(score('rx')!.q).not.toBe(score('a1')!.q);
  });

  it('count in the album the version is on, in the view and the preview alike', async () => {
    const view = db.prepare(`SELECT quality_score FROM v_release_score WHERE release_group_id = 'rg-r' AND user_id = 'u-owner'`).get() as { quality_score: number };
    expect(view.quality_score).toBeCloseTo(score('a1')!.q);
    const preview = computeScores(await scoreInputs('u-owner'), DEFAULT_WEIGHTS).albums.get('rg-r')!;
    expect(preview.quality).toBeCloseTo(view.quality_score);
  });
});
