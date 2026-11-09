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

describe('favourite genres', () => {
  it('averages the rated tracks in each genre, as the genre view has them', async () => {
    db.prepare(`INSERT OR IGNORE INTO genre_tag (entity_type, entity_id, genre_id, source, weight) VALUES ('release_group', 'rg-a', 'g-pop', 'musicbrainz', 1)`).run();
    const { lovedGenres } = await import('./home');
    const expected = db
      .prepare(
        `SELECT g.genre_id AS id, avg(s.quality_score) AS average, count(*) AS tracks
         FROM v_recording_genre g JOIN v_recording_score s ON s.recording_id = g.recording_id AND s.user_id = 'u-owner'
         GROUP BY g.genre_id HAVING count(*) >= 3`,
      )
      .all() as { id: string; average: number; tracks: number }[];
    const found = await lovedGenres('u-owner');
    expect(found.map((g) => g.id).sort()).toEqual(expected.map((e) => e.id).sort());
    for (const g of found) {
      const e = expected.find((x) => x.id === g.id)!;
      expect(g.tracks).toBe(e.tracks);
      expect(g.average).toBeCloseTo(e.average);
    }
  });
});

describe('genre families', () => {
  it('match what walking the tags in SQL gave', async () => {
    db.prepare(`INSERT OR IGNORE INTO genre_tag (entity_type, entity_id, genre_id, source, weight) VALUES ('release_group', 'rg-a', 'g-bedroom', 'musicbrainz', 1)`).run();
    db.prepare(`INSERT OR IGNORE INTO genre_tag (entity_type, entity_id, genre_id, source, weight) VALUES ('release_group', 'rg-b', 'g-rock', 'musicbrainz', 1)`).run();
    const { genresOfRecordings, genreIndex } = await import('./genres');
    const { genreFamilies } = await import('./insights');
    const reference = db
      .prepare(
        `WITH RECURSIVE up(id, root_id) AS (
           SELECT id, id FROM genre WHERE parent_id IS NULL
           UNION ALL
           SELECT g.id, up.root_id FROM genre g JOIN up ON g.parent_id = up.id
         ),
         scored AS (SELECT recording_id, quality_score FROM v_recording_score WHERE user_id = 'u-owner'),
         pairs AS (${genresOfRecordings('scored')}),
         tagged AS (SELECT DISTINCT p.recording_id, up.root_id FROM pairs p JOIN up ON up.id = p.genre_id)
         SELECT r.name AS key, r.name AS label, avg(s.quality_score) AS average, count(*) AS count
         FROM tagged t JOIN scored s ON s.recording_id = t.recording_id JOIN genre r ON r.id = t.root_id
         GROUP BY t.root_id HAVING count(*) >= 2 ORDER BY average DESC, count DESC LIMIT 12`,
      )
      .all();
    const genres = db.prepare(`SELECT id, name, parent_id FROM genre`).all() as { id: string; name: string; parent_id: string | null }[];
    const scored = db.prepare(`SELECT recording_id AS id, quality_score AS score FROM v_recording_score WHERE user_id = 'u-owner'`).all() as { id: string; score: number }[];
    const ours = genreFamilies((await genreIndex()).tracks, genres, scored);
    expect(ours.map((f) => [f.key, f.count, Math.round(f.average * 100)])).toEqual(
      (reference as { key: string; count: number; average: number }[]).map((f) => [f.key, f.count, Math.round(f.average * 100)]),
    );
  });
});
