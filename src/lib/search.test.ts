import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';
import { search, toMatchQuery } from './search';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

describe('toMatchQuery', () => {
  it('quotes each word as a prefix, so typed text is never FTS syntax', () => {
    expect(toMatchQuery('sigur ros')).toBe('"sigur"* "ros"*');
    expect(toMatchQuery('NOT a OR "b"*')).toBe('"NOT"* "a"* "OR"* "b"*');
  });

  it('needs at least two characters', () => {
    expect(toMatchQuery('a')).toBeNull();
    expect(toMatchQuery('  ')).toBeNull();
  });
});

describe('search', () => {
  it('finds artists, albums and tracks by prefix', async () => {
    const results = await search('song a', 'u-owner');
    expect(results.tracks.map((t) => t.id).sort()).toEqual(['a1', 'a2', 'a3', 'c1']);
    expect((await search('xav', null)).artists.map((a) => a.id)).toEqual(['art-x']);
    expect((await search('album b', null)).albums.map((a) => a.id)).toEqual(['rg-b']);
  });

  it('ignores accents in both directions', async () => {
    insert(db, 'artist', [{ id: 'art-b', name: 'Björk', sort_name: 'Björk', source: 'manual' }]);
    expect((await search('bjork', null)).artists.map((a) => a.id)).toEqual(['art-b']);
    expect((await search('björ', null)).artists.map((a) => a.id)).toEqual(['art-b']);
  });

  it('matches across apostrophes, typed or not', async () => {
    insert(db, 'release_group', [{ id: 'rg-d', title: 'I Didn’t Mean to Haunt You', type: 'album', source: 'manual' }]);
    for (const query of ['didnt', "didn't", 'didn’t mean']) {
      expect((await search(query, null)).albums.map((a) => a.id), query).toEqual(['rg-d']);
    }
  });

  it('follows renames', async () => {
    db.exec("UPDATE artist SET name = 'Xenia' WHERE id = 'art-x'");
    expect((await search('xav', null)).artists).toEqual([]);
    expect((await search('xen', null)).artists.map((a) => a.id)).toEqual(['art-x']);
  });
});
