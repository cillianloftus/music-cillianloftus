/**
 * An in-memory SQLite database with every migration applied, for tests
 * that need real SQL: constraints, triggers, score views and compiled
 * queries. Uses node:sqlite, so nothing touches D1 or local dev data.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url));

export function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  // D1 enforces foreign keys; match it.
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(MIGRATIONS + file, 'utf8'));
  }
  return db;
}

type Row = Record<string, string | number | null>;

/** Inserts rows into a table, using each row's keys as columns. */
export function insert(db: DatabaseSync, table: string, rows: Row[]): void {
  for (const row of rows) {
    const columns = Object.keys(row);
    db.prepare(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    ).run(...Object.values(row));
  }
}

/**
 * A small library with known answers. Two users; two artists; three albums
 * (one with a deluxe edition); a genre tree pop > indie pop > bedroom pop.
 *
 *   Album A (artist X, 2015, indie pop): tracks a1 a2 a3, deluxe adds a4
 *   Album B (artist X, 2020, bedroom pop): tracks b1 b2
 *   Album C (artist Y, 1999, rock): track c1, with a1's work re-recorded (c1 is a cover of a1)
 */
export function seedLibrary(db: DatabaseSync): void {
  insert(db, 'app_user', [
    { id: 'u-owner', email: 'owner@example.com', display_name: 'Owner', is_owner: 1 },
    { id: 'u-friend', email: 'friend@example.com', display_name: 'Friend', is_owner: 0 },
  ]);
  insert(db, 'artist', [
    { id: 'art-x', name: 'Xavier', sort_name: 'Xavier', source: 'manual' },
    { id: 'art-y', name: 'Yolanda', sort_name: 'Yolanda', source: 'manual' },
    { id: 'art-p', name: 'Pat Producer', sort_name: 'Producer, Pat', source: 'manual' },
  ]);
  insert(db, 'genre', [
    { id: 'g-pop', name: 'pop', parent_id: null },
    { id: 'g-indie', name: 'indie pop', parent_id: 'g-pop' },
    { id: 'g-bedroom', name: 'bedroom pop', parent_id: 'g-indie' },
    { id: 'g-rock', name: 'rock', parent_id: null },
  ]);
  insert(db, 'work', [{ id: 'w-a1', title: 'Song A1', source: 'manual' }]);
  insert(db, 'release_group', [
    { id: 'rg-a', title: 'Album A', type: 'album', first_release_date: '2015-03-02', date_precision: 'day', source: 'manual' },
    { id: 'rg-b', title: 'Album B', type: 'album', first_release_date: '2020', date_precision: 'year', source: 'manual' },
    { id: 'rg-c', title: 'Album C', type: 'album', first_release_date: '1999-06', date_precision: 'month', source: 'manual' },
  ]);
  insert(db, 'release', [
    { id: 'r-a', release_group_id: 'rg-a', title: 'Album A', date: '2015-03-02', date_precision: 'day', source: 'manual' },
    { id: 'r-a-deluxe', release_group_id: 'rg-a', title: 'Album A (Deluxe)', date: '2016', date_precision: 'year', source: 'manual' },
    { id: 'r-b', release_group_id: 'rg-b', title: 'Album B', date: '2020', date_precision: 'year', source: 'manual' },
    { id: 'r-c', release_group_id: 'rg-c', title: 'Album C', date: '1999-06', date_precision: 'month', source: 'manual' },
  ]);
  insert(db, 'recording', [
    { id: 'a1', title: 'Song A1', work_id: 'w-a1', source: 'manual' },
    { id: 'a2', title: 'Song A2', source: 'manual' },
    { id: 'a3', title: 'Song A3', source: 'manual' },
    { id: 'a4', title: 'Bonus A4', source: 'manual' },
    { id: 'b1', title: 'Song B1', source: 'manual' },
    { id: 'b2', title: 'Song B2', source: 'manual' },
    { id: 'c1', title: 'Song A1 (Cover)', work_id: 'w-a1', source: 'manual' },
  ]);
  insert(db, 'track', [
    { id: 't-a1', release_id: 'r-a', recording_id: 'a1', position: 1 },
    { id: 't-a2', release_id: 'r-a', recording_id: 'a2', position: 2 },
    { id: 't-a3', release_id: 'r-a', recording_id: 'a3', position: 3 },
    { id: 't-d1', release_id: 'r-a-deluxe', recording_id: 'a1', position: 1 },
    { id: 't-d2', release_id: 'r-a-deluxe', recording_id: 'a2', position: 2 },
    { id: 't-d3', release_id: 'r-a-deluxe', recording_id: 'a3', position: 3 },
    { id: 't-d4', release_id: 'r-a-deluxe', recording_id: 'a4', position: 4 },
    { id: 't-b1', release_id: 'r-b', recording_id: 'b1', position: 1 },
    { id: 't-b2', release_id: 'r-b', recording_id: 'b2', position: 2 },
    { id: 't-c1', release_id: 'r-c', recording_id: 'c1', position: 1 },
  ]);
  const primary = (entity_type: string, entity_id: string, artist_id: string) => ({
    id: `c-${entity_type}-${entity_id}-${artist_id}`,
    entity_type,
    entity_id,
    artist_id,
    role: 'primary',
  });
  insert(db, 'artist_credit', [
    primary('release_group', 'rg-a', 'art-x'),
    primary('release_group', 'rg-b', 'art-x'),
    primary('release_group', 'rg-c', 'art-y'),
    ...['a1', 'a2', 'a3', 'a4', 'b1', 'b2'].map((id) => primary('recording', id, 'art-x')),
    primary('recording', 'c1', 'art-y'),
    { id: 'c-prod', entity_type: 'recording', entity_id: 'b2', artist_id: 'art-p', role: 'producer' },
  ]);
  insert(db, 'genre_tag', [
    { entity_type: 'release_group', entity_id: 'rg-a', genre_id: 'g-indie', source: 'musicbrainz', weight: 1 },
    { entity_type: 'release_group', entity_id: 'rg-b', genre_id: 'g-bedroom', source: 'musicbrainz', weight: 1 },
    { entity_type: 'release_group', entity_id: 'rg-c', genre_id: 'g-rock', source: 'musicbrainz', weight: 1 },
    // b2 overrides its album's genre entirely.
    { entity_type: 'recording', entity_id: 'b2', genre_id: 'g-rock', source: 'manual', weight: 1 },
  ]);

  // Owner's gut scores (no calibration samples, so offset 0): score = gut * 10.
  const gut = (id: string, entity_type: string, entity_id: string, gut_score: number, user_id = 'u-owner') => ({
    id,
    user_id,
    entity_type,
    entity_id,
    depth: 'gut',
    gut_score,
    rated_at: `2026-01-01T00:00:00.${id.padStart(3, '0').slice(-3)}Z`,
  });
  insert(db, 'rating', [
    gut('1', 'recording', 'a1', 9),
    gut('2', 'recording', 'a2', 7),
    gut('3', 'recording', 'a3', 5),
    gut('4', 'recording', 'a4', 10),
    gut('5', 'recording', 'b1', 8),
    gut('6', 'recording', 'b2', 6),
    gut('7', 'recording', 'c1', 9.5),
    // The friend disagrees, and must not affect the owner's results.
    gut('8', 'recording', 'b2', 10, 'u-friend'),
  ]);
}
