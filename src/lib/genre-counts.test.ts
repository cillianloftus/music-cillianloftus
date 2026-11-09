import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { migratedDb, seedLibrary } from '../test/db';
import { trackCountsByGenre } from './genres';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

const fromView = () =>
  Object.fromEntries(
    (db.prepare(`SELECT genre_id, count(DISTINCT recording_id) AS n FROM v_recording_genre GROUP BY genre_id`).all() as { genre_id: string; n: number }[]).map(
      (r) => [r.genre_id, r.n],
    ),
  );

describe('tracks per genre', () => {
  it('counts what the genre view says, without building it', async () => {
    const tags = [
      // Album genres, inherited by tracks with none of their own.
      { entity_type: 'release_group', entity_id: 'rg-a', genre_id: 'g-indie', source: 'musicbrainz', weight: 1 },
      { entity_type: 'release_group', entity_id: 'rg-b', genre_id: 'g-pop', source: 'musicbrainz', weight: 1 },
      // A track's own genres replace its album's.
      { entity_type: 'recording', entity_id: 'a1', genre_id: 'g-bedroom', source: 'musicbrainz', weight: 1 },
      // Hand-set ones stand alone over the rest.
      { entity_type: 'recording', entity_id: 'a2', genre_id: 'g-rock', source: 'manual', weight: 1 },
      { entity_type: 'recording', entity_id: 'a2', genre_id: 'g-pop', source: 'musicbrainz', weight: 1 },
    ];
    // Beside the seed's own tags; any it already has are left as they are.
    for (const t of tags) db.prepare('INSERT OR IGNORE INTO genre_tag (entity_type, entity_id, genre_id, source, weight) VALUES (?, ?, ?, ?, ?)').run(t.entity_type, t.entity_id, t.genre_id, t.source, t.weight);
    expect(await trackCountsByGenre()).toEqual(fromView());
  });
});

describe('album genres, read raw', () => {
  it('keeps an album’s hand-set genres alone when it has any', async () => {
    const { albumGenres } = await import('./genres');
    expect(
      albumGenres([
        { a: 'x', g: 'rock', manual: 0 },
        { a: 'x', g: 'pop', manual: 1 },
        { a: 'y', g: 'rock', manual: 0 },
        { a: 'y', g: 'rock', manual: 0 },
      ]),
    ).toEqual([
      { a: 'x', g: 'pop' },
      { a: 'y', g: 'rock' },
    ]);
  });
});
