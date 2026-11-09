import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { migratedDb, seedLibrary } from '../../test/db';
import { compile, type CompileOptions } from './compile';
import { definitionSchema } from './schema';

// Owner scores in the fixture (gut x 10):
//   a1 90, a2 70, a3 50, a4 100 (deluxe bonus), b1 80, b2 60, c1 95 (cover of a1)

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
});

function run(definition: unknown, options: Partial<CompileOptions> = {}): string[] {
  const { sql, params } = compile(definitionSchema.parse(definition), { userId: 'u-owner', ...options });
  return db
    .prepare(sql)
    .all(...(params as (string | number | null)[]))
    .map((row) => row.id as string);
}

const tracks = (where: unknown, extra: object = {}) => ({ entity: 'recording', where, ...extra });

describe('filters and sorting', () => {
  it('filters on a score and sorts by it, highest first by default', () => {
    expect(run(tracks({ field: 'personal_score', op: 'gte', value: 80 }, { collapse_by_work: false }))).toEqual([
      'a4',
      'c1',
      'a1',
      'b1',
    ]);
  });

  it('compares text case-insensitively', () => {
    expect(run(tracks({ field: 'title', op: 'eq', value: 'song b1' }))).toEqual(['b1']);
    expect(run(tracks({ field: 'title', op: 'contains', value: 'BONUS' }))).toEqual(['a4']);
  });

  it('combines and/or', () => {
    const where = {
      or: [
        { field: 'title', op: 'eq', value: 'Song B1' },
        { and: [{ field: 'personal_score', op: 'gte', value: 95 }, { field: 'artist', op: 'eq', value: 'yolanda' }] },
      ],
    };
    expect(run(tracks(where))).toEqual(['c1', 'b1']);
  });

  it('applies the limit after sorting', () => {
    expect(run({ entity: 'recording', limit: 2, collapse_by_work: false })).toEqual(['a4', 'c1']);
  });
});

describe('collapse_by_work', () => {
  it('keeps one recording per work, the higher scored by default', () => {
    // a1 (90) and its cover c1 (95) share a work.
    expect(run(tracks({ field: 'personal_score', op: 'gte', value: 80 }))).toEqual(['a4', 'c1', 'b1']);
  });

  it('prefers the work’s preferred recording over score', () => {
    db.exec("UPDATE work SET preferred_recording_id = 'a1' WHERE id = 'w-a1'");
    expect(run(tracks({ field: 'personal_score', op: 'gte', value: 80 }))).toEqual(['a4', 'a1', 'b1']);
  });
});

describe('dates at their precision', () => {
  const albums = (where: unknown) => ({ entity: 'release_group', where, sort: [{ field: 'first_release_date', dir: 'asc' }] });

  it('eq matches anything within the given period', () => {
    expect(run(albums({ field: 'first_release_date', op: 'eq', value: '2015' }))).toEqual(['rg-a']);
    expect(run(albums({ field: 'first_release_date', op: 'eq', value: '1999-06' }))).toEqual(['rg-c']);
  });

  it('lte includes the whole period; gt excludes it', () => {
    expect(run(albums({ field: 'first_release_date', op: 'lte', value: '2015' }))).toEqual(['rg-c', 'rg-a']);
    expect(run(albums({ field: 'first_release_date', op: 'gt', value: '2015' }))).toEqual(['rg-b']);
  });

  it('between is inclusive at both ends', () => {
    expect(run(albums({ field: 'first_release_date', op: 'between', value: ['1999', '2015'] }))).toEqual([
      'rg-c',
      'rg-a',
    ]);
  });

  it('tracks inherit their album’s date when they have none', () => {
    const ids = run(tracks({ field: 'first_release_date', op: 'eq', value: '2015' }));
    expect(ids.sort()).toEqual(['a1', 'a2', 'a3', 'a4']);
  });
});

describe('genres', () => {
  it('in_tree includes every genre beneath the named one', () => {
    // b2 overrides its album's bedroom pop with rock, so it is not pop.
    const ids = run(tracks({ field: 'genre', op: 'in_tree', value: 'pop' }, { collapse_by_work: false }));
    expect(ids.sort()).toEqual(['a1', 'a2', 'a3', 'a4', 'b1']);
  });

  it('eq matches only that genre', () => {
    const ids = run(tracks({ field: 'genre', op: 'eq', value: 'indie pop' }));
    expect(ids.sort()).toEqual(['a1', 'a2', 'a3', 'a4']);
  });

  it('a track’s own tags replace its album’s', () => {
    const ids = run(tracks({ field: 'genre', op: 'eq', value: 'rock' }));
    expect(ids.sort()).toEqual(['b2', 'c1']);
  });

  it('works for albums', () => {
    expect(run({ entity: 'release_group', where: { field: 'genre', op: 'in_tree', value: 'indie pop' } }).sort()).toEqual([
      'rg-a',
      'rg-b',
    ]);
  });
});

describe('credits', () => {
  it('finds tracks by producer', () => {
    expect(run(tracks({ field: 'producer', op: 'contains', value: 'pat' }))).toEqual(['b2']);
  });

  it('finds albums through their tracks’ credits', () => {
    expect(run({ entity: 'release_group', where: { field: 'producer', op: 'eq', value: 'Pat Producer' } })).toEqual([
      'rg-b',
    ]);
  });

  it('not_in excludes an artist', () => {
    const ids = run(tracks({ field: 'artist', op: 'not_in', value: ['Xavier'] }));
    expect(ids).toEqual(['c1']);
  });
});

describe('grouping', () => {
  it('keeps the top N per group, then sorts overall', () => {
    const definition = {
      entity: 'recording',
      collapse_by_work: false,
      group: { by: 'artist', limit_per_group: 2 },
    };
    expect(run(definition)).toEqual(['a4', 'c1', 'a1']);
  });

  it('groups by album', () => {
    const definition = { entity: 'recording', collapse_by_work: false, group: { by: 'album', limit_per_group: 1 } };
    // a4 appears only on Album A's deluxe edition, so it belongs to Album A.
    expect(run(definition)).toEqual(['a4', 'c1', 'b1']);
  });
});

describe('album scores', () => {
  it('trims the lowest track and ignores deluxe bonus tracks', () => {
    // A: 90, 70, 50 -> drop 50 -> 80 (a4 is deluxe-only). B: 80, 60 -> 80. C: 95.
    expect(run({ entity: 'release_group' })).toEqual(['rg-c', 'rg-a', 'rg-b']);
  });

  it('filters on coverage', () => {
    expect(run({ entity: 'release_group', where: { field: 'coverage', op: 'eq', value: 1 } }).sort()).toEqual([
      'rg-a',
      'rg-b',
      'rg-c',
    ]);
  });
});

describe('artists', () => {
  it('sorts by aggregate score', () => {
    const definition = { entity: 'artist', where: { field: 'rated_track_count', op: 'gte', value: 1 }, sort: [{ field: 'avg_track_rating', dir: 'desc' }] };
    // Y: 95. X: mean of 90, 70, 50, 100, 80, 60 = 75.
    expect(run(definition)).toEqual(['art-y', 'art-x']);
  });
});

describe('users, pins and excludes', () => {
  it('scores come only from the given user', () => {
    expect(run(tracks({ field: 'personal_score', op: 'gte', value: 80 }), { userId: 'u-friend' })).toEqual(['b2']);
  });

  it('excludes always win; pins bypass filters', () => {
    const definition = tracks({ field: 'personal_score', op: 'gte', value: 80 });
    expect(run(definition, { excludes: ['a4'], pins: ['b2'] })).toEqual(['c1', 'b1', 'b2']);
  });
});

describe('safety', () => {
  it('treats hostile values as data', () => {
    const ids = run(tracks({ field: 'title', op: 'contains', value: "'; DROP TABLE rating; --" }));
    expect(ids).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM rating').get()!.n).toBe(8);
  });

  it('only ever emits a single read statement', () => {
    const definitions = [
      { entity: 'recording' },
      tracks({ field: 'genre', op: 'in_tree', value: 'x' }, { group: { by: 'year', limit_per_group: 3 } }),
      { entity: 'release_group', where: { field: 'owned', op: 'eq', value: false } },
      { entity: 'artist', where: { field: 'name', op: 'in', value: ['a', 'b'] } },
    ];
    for (const definition of definitions) {
      const { sql } = compile(definitionSchema.parse(definition), { userId: 'u-owner' });
      expect(sql.trimStart().startsWith('WITH')).toBe(true);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|PRAGMA|REPLACE)\b/i);
      expect(sql.includes(';')).toBe(false);
    }
  });
});

describe('fields from Deezer, ListenBrainz and MusicBrainz', () => {
  it('filters tracks on tempo, version, explicit and listeners, and albums on lists', () => {
    db.exec(`UPDATE recording SET bpm = 150, explicit = 1, listener_count = 40 WHERE id = 'a1'`);
    db.exec(`UPDATE recording SET bpm = 90, is_live = 1, listener_count = 90000 WHERE id = 'b1'`);
    const opts = { collapse_by_work: false };
    expect(run(tracks({ field: 'bpm', op: 'gte', value: 120 }, opts))).toEqual(['a1']);
    expect(run(tracks({ field: 'version', op: 'eq', value: 'live' }, opts))).toEqual(['b1']);
    expect(run(tracks({ field: 'explicit', op: 'eq', value: 'yes' }, opts))).toEqual(['a1']);
    expect(run(tracks({ field: 'listeners', op: 'lt', value: 1000 }, opts))).toEqual(['a1']);
    db.exec(`INSERT INTO series (id, mbid, name, type) VALUES ('s1', 'mb-s1', 'A list', 'Release group series')`);
    db.exec(`INSERT INTO release_group_series (release_group_id, series_id, number) VALUES ('rg-b', 's1', '3')`);
    expect(run({ entity: 'release_group', where: { field: 'lists', op: 'gte', value: 1 } })).toEqual(['rg-b']);
  });
});
