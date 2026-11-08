import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';
import { editDistance, search, toMatchQuery } from './search';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

describe('toMatchQuery', () => {
  it('quotes each word as a prefix, so typed text is never FTS syntax, or the whole squashed', () => {
    expect(toMatchQuery('sigur')).toBe('"sigur"*');
    expect(toMatchQuery('sigur ros')).toBe('("sigur"* "ros"*) OR "sigurros"*');
    expect(toMatchQuery('NOT a OR "b"*')).toBe('("NOT"* "a"* "OR"* "b"*) OR "NOTaORb"*');
    expect(toMatchQuery('a$ap')).toBe('("a"* "ap"*) OR "asap"*');
  });
});

describe('editDistance', () => {
  it('counts typos, a swapped pair as one', () => {
    expect(editDistance('quadeca', 'quadeca')).toBe(0);
    expect(editDistance('quadecca', 'quadeca')).toBe(1);
    expect(editDistance('qaudeca', 'quadeca')).toBe(1);
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('abc', 'xyzabc', 2)).toBe(3);
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

  it('finds an artist’s albums by their name, after any title matches', async () => {
    const results = await search('yolan', 'u-owner');
    expect(results.artists).toEqual([expect.objectContaining({ id: 'art-y', name: 'Yolanda', releases: 1 })]);
    expect(results.albums.map((a) => a.id)).toEqual(['rg-c']);
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

  it('finds names however they are punctuated', async () => {
    insert(db, 'artist', [
      { id: 'art-k', name: 'K.A.A.N.', sort_name: 'K.A.A.N.', source: 'manual' },
      { id: 'art-acdc', name: 'AC/DC', sort_name: 'AC/DC', source: 'manual' },
      { id: 'art-asap', name: 'A$AP Rocky', sort_name: 'A$AP Rocky', source: 'manual' },
    ]);
    for (const [query, id] of [
      ['kaan', 'art-k'],
      ['KAA', 'art-k'],
      ['k.a.a.n', 'art-k'],
      ['acdc', 'art-acdc'],
      ['ac dc', 'art-acdc'],
      ['asap', 'art-asap'],
      ['asap rocky', 'art-asap'],
      ['rocky', 'art-asap'],
    ]) {
      expect((await search(query!, null)).artists.map((a) => a.id), query).toContain(id);
    }
  });

  it('forgives a typo when nothing matches exactly', async () => {
    insert(db, 'artist', [{ id: 'art-q', name: 'Quadeca', sort_name: 'Quadeca', source: 'manual' }]);
    expect((await search('quadecca', null)).artists.map((a) => a.id)).toEqual(['art-q']);
    expect((await search('quadeka', null)).artists.map((a) => a.id)).toEqual(['art-q']);
    // Too far off to be a typo.
    expect((await search('quarterly', null)).artists).toEqual([]);
  });

  it('follows renames', async () => {
    db.exec("UPDATE artist SET name = 'Xenia' WHERE id = 'art-x'");
    expect((await search('xav', null)).artists).toEqual([]);
    expect((await search('xen', null)).artists.map((a) => a.id)).toEqual(['art-x']);
  });
});
