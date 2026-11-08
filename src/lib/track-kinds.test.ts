import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';
import { kindsOf, markedTracks, setKind, skipSuggestion, suggestions } from './track-kinds';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
  // Album B gains a short skit and an outro; a2 is long.
  insert(db, 'recording', [
    { id: 'sk', title: 'Mom Skit', length_ms: 40_000, source: 'manual' },
    { id: 'out', title: 'Outro', length_ms: 200_000, source: 'manual' },
  ]);
  insert(db, 'track', [
    { id: 't-sk', release_id: 'r-b', recording_id: 'sk', position: 3 },
    { id: 't-out', release_id: 'r-b', recording_id: 'out', position: 4 },
  ]);
  db.exec(`UPDATE recording SET length_ms = 240000 WHERE id IN ('b1', 'b2'); UPDATE recording SET length_ms = 80000 WHERE id = 'a3'`);
});

describe('track kinds', () => {
  it('suggests short tracks and ones titled as interludes, guessing skit from the title', async () => {
    const { rows, total } = await suggestions(90);
    expect(rows.map((r) => [r.id, r.kind]).sort()).toEqual([
      ['a3', 'interlude'],
      ['out', 'interlude'],
      ['sk', 'skit'],
    ]);
    expect(total).toBe(3);
    expect((await suggestions(60)).rows.map((r) => r.id).sort()).toEqual(['out', 'sk']);
  });

  it('stops suggesting a track once answered, and puts a skipped one last', async () => {
    await setKind('a3', 'song');
    await skipSuggestion('sk');
    expect((await suggestions(90)).rows.map((r) => r.id)).toEqual(['out', 'sk']);
    await setKind('sk', 'skit');
    expect([...(await kindsOf(['a3', 'sk', 'b1']))]).toEqual([['sk', 'skit']]);
    expect((await markedTracks()).map((r) => r.id)).toEqual(['sk']);
  });

  it('a skit has no score and leaves its album; an interlude counts at its weight', async () => {
    insert(db, 'rating', [
      { id: 'r-sk', user_id: 'u-owner', entity_type: 'recording', entity_id: 'sk', depth: 'gut', gut_score: 1, rated_at: '2026-03-01T00:00:00.000Z' },
    ]);
    db.exec(`INSERT INTO weights (id, user_id, version, payload_json, active) VALUES ('w1', 'u-owner', 1, '{"release":{"trim_lowest":0}}', 1)`);
    const album = () => db.prepare(`SELECT quality_score q, track_count n FROM v_release_score WHERE release_group_id = 'rg-b' AND user_id = 'u-owner'`).get() as { q: number; n: number };
    // b1 80, b2 60, skit 10: (80 + 60 + 10) / 3 = 50.
    expect(album().q).toBeCloseTo(50, 9);
    await setKind('sk', 'skit');
    expect(album()).toEqual({ q: 70, n: 3 });
    expect(db.prepare(`SELECT count(*) n FROM v_recording_score WHERE recording_id = 'sk'`).get()).toEqual({ n: 0 });
    // b2 as an interlude at ½: (80 + 0.5 × 60) / 1.5.
    await setKind('b2', 'interlude');
    expect(album().q).toBeCloseTo(110 / 1.5, 9);
  });
});
