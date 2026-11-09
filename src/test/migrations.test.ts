/**
 * The rules the schema itself enforces (migrations 0001–0005): append-only
 * ratings, date precision, polymorphic references, and the score views.
 */

import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { insert, migratedDb, seedLibrary } from './db';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
});

const one = (sql: string, ...params: (string | number | null)[]) => db.prepare(sql).get(...params)!;

describe('ratings are append-only', () => {
  it('refuses updates to a rating', () => {
    expect(() => db.exec("UPDATE rating SET gut_score = 1 WHERE id = '1'")).toThrow(/append-only/);
  });

  it('refuses deletes', () => {
    expect(() => db.exec("DELETE FROM rating WHERE id = '1'")).toThrow(/append-only/);
  });

  it('allows a merge to reparent a rating, but only onto an existing entity', () => {
    db.exec("UPDATE rating SET entity_id = 'a2' WHERE id = '1'");
    expect(() => db.exec("UPDATE rating SET entity_id = 'missing' WHERE id = '1'")).toThrow(/missing entity/);
  });

  it('keeps depth truthful', () => {
    const row = { id: 'x', user_id: 'u-owner', entity_type: 'recording', entity_id: 'a1' };
    expect(() => insert(db, 'rating', [{ ...row, depth: 'gut', gut_score: 5, production: 5 }])).toThrow();
    expect(() => insert(db, 'rating', [{ ...row, depth: 'detailed', gut_score: 5 }])).toThrow();
    expect(() => insert(db, 'rating', [{ ...row, depth: 'detailed', sequencing: 5 }])).toThrow(); // album axis on a track
  });
});

describe('dates carry their precision', () => {
  const group = (first_release_date: string | null, date_precision: string) => () =>
    insert(db, 'release_group', [
      { id: 'rg-x', title: 'X', type: 'album', first_release_date, date_precision, source: 'manual' },
    ]);

  it('accepts a date that matches its precision', () => {
    expect(group('1982-11', 'month')).not.toThrow();
  });

  it.each([
    ['1982-11', 'year'],
    ['1982', 'day'],
    ['1982-02-30', 'day'],
    [null, 'year'],
  ])('rejects %s at %s precision', (date, precision) => {
    expect(group(date, precision)).toThrow();
  });
});

describe('polymorphic references', () => {
  it('reject credits, tags and ratings pointing at nothing', () => {
    expect(() =>
      insert(db, 'artist_credit', [{ id: 'c', entity_type: 'recording', entity_id: 'nope', artist_id: 'art-x', role: 'primary' }]),
    ).toThrow(/missing entity/);
    expect(() =>
      insert(db, 'genre_tag', [{ entity_type: 'release_group', entity_id: 'a1', genre_id: 'g-pop', source: 'manual' }]),
    ).toThrow(/missing entity/);
    expect(() =>
      insert(db, 'rating', [{ id: 'r', user_id: 'u-owner', entity_type: 'recording', entity_id: 'nope', depth: 'gut', gut_score: 1 }]),
    ).toThrow(/missing entity/);
  });
});

describe('score views', () => {
  it('calibrates gut scores against considered ones', () => {
    // Craft mean 6 against a gut of 8: the gut runs 2 high.
    insert(db, 'rating', [
      {
        id: 'cal',
        user_id: 'u-owner',
        entity_type: 'recording',
        entity_id: 'a3',
        depth: 'detailed',
        gut_score: 8,
        production: 6,
        songwriting: 6,
        lyrics: 6,
        performance: 6,
        rated_at: '2026-02-01T00:00:00.000Z',
      },
    ]);
    expect(one("SELECT gut_offset FROM v_gut_calibration WHERE user_id = 'u-owner'").gut_offset).toBe(-2);
    // A gut-only 9 now reads as 7.
    expect(one("SELECT quality_score FROM v_recording_score WHERE recording_id = 'a1' AND user_id = 'u-owner'").quality_score).toBe(70);
  });

  it('uses the latest rating only', () => {
    insert(db, 'rating', [
      { id: 'later', user_id: 'u-owner', entity_type: 'recording', entity_id: 'a1', depth: 'gut', gut_score: 2, rated_at: '2026-06-01T00:00:00.000Z' },
    ]);
    expect(one("SELECT quality_score FROM v_recording_score WHERE recording_id = 'a1' AND user_id = 'u-owner'").quality_score).toBe(20);
  });

  it('adds impact as flat points on top of a capped quality score', () => {
    insert(db, 'rating', [
      { id: 'imp', user_id: 'u-owner', entity_type: 'recording', entity_id: 'a4', depth: 'gut', gut_score: 10, impact: 10, rated_at: '2026-06-01T00:00:00.000Z' },
    ]);
    const row = one("SELECT quality_score, personal_score FROM v_recording_score WHERE recording_id = 'a4' AND user_id = 'u-owner'");
    expect(row).toMatchObject({ quality_score: 100, personal_score: 110 });
  });

  it('blends tracks 70/30 with the album axes', () => {
    // Tracks part for Album A: (90 + 70 + 50) / 3 = 70; with three tracks the
    // lowest is a third of the album, so it counts (0057). Album axes: 9 -> 90.
    insert(db, 'rating', [
      { id: 'alb', user_id: 'u-owner', entity_type: 'release_group', entity_id: 'rg-a', depth: 'detailed', sequencing: 9, cohesion: 9, ambition: 9 },
    ]);
    const row = one("SELECT quality_score, rated_track_count, track_count FROM v_release_score WHERE release_group_id = 'rg-a' AND user_id = 'u-owner'");
    expect(row.quality_score).toBeCloseTo(76);
    expect(row).toMatchObject({ rated_track_count: 3, track_count: 3 });
  });

  it('reads weights from the active weights version', () => {
    insert(db, 'weights', [
      { id: 'w1', user_id: 'u-owner', version: 1, active: 1, payload_json: JSON.stringify({ release: { trim_lowest: 0 } }) },
    ]);
    // Untrimmed: (90 + 70 + 50) / 3 = 70.
    expect(one("SELECT quality_score FROM v_release_score WHERE release_group_id = 'rg-a' AND user_id = 'u-owner'").quality_score).toBeCloseTo(70);
  });
});

describe('canonical edition', () => {
  it('is the earliest dated edition', () => {
    expect(one("SELECT release_id FROM v_release_group_canonical WHERE release_group_id = 'rg-a'").release_id).toBe('r-a');
  });

  it('breaks a same-day tie by fewest tracks, whatever the import order', () => {
    insert(db, 'release', [
      { id: 'r-a-cd', release_group_id: 'rg-a', title: 'Album A (CD)', date: '2015-03-02', date_precision: 'day', source: 'manual', created_at: '2000-01-01T00:00:00.000Z' },
    ]);
    insert(db, 'track', [1, 2, 3, 4, 5].map((n) => ({ id: `cd-${n}`, release_id: 'r-a-cd', recording_id: 'a1', disc: 1, position: n })));
    expect(one("SELECT release_id FROM v_release_group_canonical WHERE release_group_id = 'rg-a'").release_id).toBe('r-a');
  });

  it('sorts a bare year after full dates within it', () => {
    insert(db, 'release', [
      { id: 'r-a-2015', release_group_id: 'rg-a', title: 'Album A (2015)', date: '2015', date_precision: 'year', source: 'manual', created_at: '2000-01-01T00:00:00.000Z' },
    ]);
    expect(one("SELECT release_id FROM v_release_group_canonical WHERE release_group_id = 'rg-a'").release_id).toBe('r-a');
  });

  it('defers to a preferred release', () => {
    db.exec("UPDATE release_group SET preferred_release_id = 'r-a-deluxe' WHERE id = 'rg-a'");
    expect(one("SELECT release_id FROM v_release_group_canonical WHERE release_group_id = 'rg-a'").release_id).toBe('r-a-deluxe');
  });

  it('refuses a preferred release from another album', () => {
    expect(() => db.exec("UPDATE release_group SET preferred_release_id = 'r-b' WHERE id = 'rg-a'")).toThrow();
  });
});
