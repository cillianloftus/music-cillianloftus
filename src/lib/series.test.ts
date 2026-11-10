import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { migratedDb, seedLibrary } from '../test/db';
import { allSeries, seriesAlbums } from './series';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
  db.exec(`INSERT INTO series (id, mbid, name, type) VALUES ('s1', 'mb-1', 'Best of', 'Release group series'), ('s2', 'mb-2', 'Prize', 'Release group award')`);
  db.exec(`INSERT INTO release_group_series (release_group_id, series_id, number) VALUES
           ('rg-a', 's1', '12'), ('rg-b', 's1', '3'), ('rg-c', 's1', NULL), ('rg-a', 's2', '2016 winner')`);
});

describe('lists', () => {
  it('orders a list by place, then the rest newest first', async () => {
    expect((await seriesAlbums('s1', 'u-owner')).map((e) => [e.album.id, e.number])).toEqual([
      ['rg-b', '3'],
      ['rg-a', '12'],
      ['rg-c', null],
    ]);
  });

  it('lists every list by how many albums it holds', async () => {
    expect((await allSeries()).map((s) => [s.name, s.albums])).toEqual([
      ['Best of', 3],
      ['Prize', 1],
    ]);
  });
});
