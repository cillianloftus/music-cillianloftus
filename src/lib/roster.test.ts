import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { migratedDb, seedLibrary } from '../test/db';
import { roster, sortRoster, type Roster, type RosterArtist } from './roster';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

describe('roster', () => {
  it('lists artists with music of their own, not those only credited as producers', async () => {
    const { artists } = await roster('u-owner');
    expect(artists.map((a) => a.id).sort()).toEqual(['art-x', 'art-y']);
    const x = artists.find((a) => a.id === 'art-x')!;
    expect(x.releases).toBe(2);
    expect(x.rated).toBeGreaterThan(0);
  });

  it('faces each artist with the cover of their newest album, from its canonical edition', async () => {
    db.prepare("UPDATE release SET art_key = 'cover/a' WHERE id = 'r-a'").run();
    db.prepare("UPDATE release SET art_key = 'cover/a-deluxe' WHERE id = 'r-a-deluxe'").run();
    db.prepare("UPDATE release SET art_key = 'cover/c' WHERE id = 'r-c'").run();
    const { artists } = await roster('u-owner');
    // Album B (2020) has no cover, so Xavier falls back to Album A's standard edition.
    expect(artists.find((a) => a.id === 'art-x')!.art_key).toBe('cover/a');
    expect(artists.find((a) => a.id === 'art-y')!.art_key).toBe('cover/c');
    db.prepare("UPDATE release SET art_key = 'cover/b' WHERE id = 'r-b'").run();
    expect((await roster('u-owner')).artists.find((a) => a.id === 'art-x')!.art_key).toBe('cover/b');
  });

  it('carries the viewer’s average track score for weighing', async () => {
    expect((await roster('u-owner')).mean).not.toBeNull();
    expect((await roster('u-nobody')).mean).toBeNull();
  });
});

describe('sortRoster', () => {
  const artist = (id: string, over: Partial<RosterArtist>): RosterArtist => ({
    id, name: id, sort_name: id, kind: null, image_key: null, art_key: null,
    created_at: '2026-01-01', releases: 0, rated: 0, average: null, ...over,
  });
  const list: Roster = {
    mean: 70,
    artists: [
      artist('one-hit', { average: 99, rated: 1, releases: 1, created_at: '2026-03-01' }),
      artist('steady', { average: 95, rated: 20, releases: 3, created_at: '2026-02-01' }),
      artist('unrated', { releases: 9, sort_name: 'aardvark' }),
      artist('Middling', { average: 80, rated: 5, releases: 1 }),
    ],
  };
  const ids = (sort: Parameters<typeof sortRoster>[1]) => sortRoster(list, sort).map((a) => a.id);

  it('by score, weighs each average by how much is rated, the unrated last', () => {
    expect(ids('score')).toEqual(['steady', 'one-hit', 'Middling', 'unrated']);
  });

  it('by the other orders', () => {
    expect(ids('rated')).toEqual(['steady', 'Middling', 'one-hit', 'unrated']);
    expect(ids('releases')).toEqual(['unrated', 'steady', 'one-hit', 'Middling']);
    expect(ids('recent')[0]).toBe('one-hit');
    // Case folds, as SQLite's NOCASE did.
    expect(ids('name')).toEqual(['unrated', 'Middling', 'one-hit', 'steady']);
  });

  it('leaves the cached list as it was', () => {
    const before = list.artists.map((a) => a.id);
    sortRoster(list, 'name');
    expect(list.artists.map((a) => a.id)).toEqual(before);
  });
});
