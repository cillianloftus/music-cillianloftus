import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { d1 } from '../test/d1';
import { migratedDb, seedLibrary } from '../test/db';
import { addParent, createGenre, deriveAlbumGenres, genreKey, GenreError, moveGenre, plainGenreName, removeParent, wikidataParents } from './genres';
import { compile } from './query/compile';
import { definitionSchema } from './query/schema';
import { insert } from '../test/db';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db); // pop > indie pop > bedroom pop; rock
  (env as { DB: D1Database }).DB = d1(db);
});

afterEach(() => vi.unstubAllGlobals());

const parentOf = (id: string) => (db.prepare(`SELECT parent_id FROM genre WHERE id = ?`).get(id) as { parent_id: string | null }).parent_id;

describe('moving genres', () => {
  it('moves beneath a genre named in any case, or to the top level', async () => {
    await moveGenre('g-rock', 'POP');
    expect(parentOf('g-rock')).toBe('g-pop');
    await moveGenre('g-rock', null);
    expect(parentOf('g-rock')).toBeNull();
  });

  it('refuses a cycle at any depth, and says why', async () => {
    await expect(moveGenre('g-pop', 'bedroom pop')).rejects.toThrow(GenreError);
    await expect(moveGenre('g-pop', 'pop')).rejects.toThrow('beneath itself');
    expect(parentOf('g-pop')).toBeNull();
  });

  it('refuses an unknown parent or genre', async () => {
    await expect(moveGenre('g-rock', 'polka')).rejects.toThrow('no genre called');
    await expect(moveGenre('nope', 'pop')).rejects.toThrow('no longer exists');
  });
});

describe('creating genres', () => {
  it('adds a lower-case genre beneath a parent', async () => {
    const id = await createGenre('  Chamber  Pop ', 'pop');
    expect(db.prepare(`SELECT name, parent_id FROM genre WHERE id = ?`).get(id)).toEqual({ name: 'chamber pop', parent_id: 'g-pop' });
  });

  it('refuses a duplicate or an empty name', async () => {
    await expect(createGenre('Rock', null)).rejects.toThrow('already a genre');
    await expect(createGenre('   ', null)).rejects.toThrow(GenreError);
  });
});

describe('Wikidata suggestions', () => {
  it('reads subclass labels, plain, without the genre itself or "music genre"', async () => {
    let sent = '';
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      sent = String(init.body);
      return Response.json({
        results: {
          bindings: [
            { name: { value: 'indie pop' }, parentLabel: { value: 'pop music' } },
            { name: { value: 'indie pop' }, parentLabel: { value: 'indie music' } },
            { name: { value: 'indie pop' }, parentLabel: { value: 'pop music' } },
            { name: { value: 'shoegaze' }, parentLabel: { value: 'music genre' } },
            { name: { value: 'shoegaze' }, parentLabel: { value: 'popular music' } },
            { name: { value: 'shoegaze' }, parentLabel: { value: 'music of North America' } },
          ],
        },
      });
    });
    const parents = await wikidataParents(['indie pop', 'shoegaze', 'an "odd" name\nwith a break']);
    expect(parents).toEqual(new Map([['indie pop', ['pop', 'indie']]]));
    // The odd name was neutralised rather than allowed to break the query.
    expect(decodeURIComponent(sent.replace(/\+/g, ' '))).toContain('"an  odd  name with a break"@en');
  });

  it('treats spelling variants of a name as one genre', () => {
    expect(genreKey('Hip-Hop')).toBe(genreKey('hip hop'));
    expect(genreKey('lo‐fi')).toBe('lo fi');
  });

  it('drops a trailing "music" from labels', () => {
    expect(plainGenreName('Rock music')).toBe('rock');
    expect(plainGenreName('art pop')).toBe('art pop');
  });
});

describe('deriving album genres', () => {
  // Album A's standard edition has a1, a2, a3 (the deluxe-only a4 does not count).
  const tag = (entity_id: string, genre_id: string, source = 'manual') => ({ entity_type: 'recording', entity_id, genre_id, source, weight: 1 });
  const derived = () =>
    db.prepare(`SELECT entity_id, genre_id, weight FROM genre_tag WHERE source = 'derived' ORDER BY entity_id, weight DESC, genre_id`).all();

  it('derives a genre on at least 40% of the standard tracks, weighted by share', async () => {
    insert(db, 'genre_tag', [tag('a1', 'g-rock'), tag('a2', 'g-rock'), tag('a3', 'g-bedroom'), tag('a4', 'g-bedroom')]);
    // Album B already derives rock from b2's own tag (one of two tracks).
    expect(await deriveAlbumGenres()).toBe(2);
    expect(derived()).toEqual([
      { entity_id: 'rg-a', genre_id: 'g-rock', weight: 0.667 },
      { entity_id: 'rg-b', genre_id: 'g-rock', weight: 0.5 },
    ]);
  });

  it('replaces its own rows on every run and leaves other album tags alone', async () => {
    insert(db, 'genre_tag', [tag('a1', 'g-rock'), tag('a2', 'g-rock')]);
    await deriveAlbumGenres();
    db.exec(`DELETE FROM genre_tag WHERE entity_type = 'recording' AND entity_id = 'a2'`);
    await deriveAlbumGenres();
    expect(derived()).toEqual([{ entity_id: 'rg-b', genre_id: 'g-rock', weight: 0.5 }]);
    // The imported tag on Album A is still there.
    expect(db.prepare(`SELECT source FROM genre_tag WHERE entity_type = 'release_group' AND entity_id = 'rg-a'`).all()).toEqual([{ source: 'musicbrainz' }]);
  });
});

describe('more than one parent', () => {
  it('finds a genre under every parent it has, in playlist queries', async () => {
    // b2 is tagged rock. File rock under pop as well: a "pop" query then finds b2.
    const popTracks = () => {
      const { sql, params } = compile(definitionSchema.parse({ entity: 'recording', where: { field: 'genre', op: 'in_tree', value: 'pop' }, collapse_by_work: false, limit: 50 }), { userId: 'u-owner' });
      return (db.prepare(sql).all(...(params as never[])) as { id: string }[]).map((r) => r.id);
    };
    expect(popTracks()).not.toContain('b2');
    await addParent('g-rock', 'pop');
    expect(popTracks()).toContain('b2');
    await removeParent('g-rock', 'g-pop');
    expect(popTracks()).not.toContain('b2');
  });

  it('refuses a cycle through any mix of primary and further parents', async () => {
    // pop > indie pop > bedroom pop. pop under bedroom pop would loop.
    await expect(addParent('g-pop', 'bedroom pop')).rejects.toThrow('beneath itself');
    await addParent('g-rock', 'bedroom pop');
    // Now rock is beneath bedroom pop; bedroom pop may not go beneath rock.
    await expect(moveGenre('g-bedroom', 'rock')).rejects.toThrow(GenreError);
  });

  it('will not add the main parent twice', async () => {
    await expect(addParent('g-indie', 'pop')).rejects.toThrow('main parent');
  });
});
