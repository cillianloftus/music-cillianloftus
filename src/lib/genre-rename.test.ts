import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

describe('renaming a genre', () => {
  it('renames everywhere, and keeps the old name so imports land on it', async () => {
    const { renameGenre } = await import('./genres');
    await renameGenre('g-indie', 'Indie-Pop');
    expect(db.prepare(`SELECT name FROM genre WHERE id = 'g-indie'`).get()).toEqual({ name: 'Indie-Pop' });
    expect(db.prepare(`SELECT genre_id FROM genre_alias WHERE name = 'indie pop'`).get()).toEqual({ genre_id: 'g-indie' });
    // Capitals only: no alias needed.
    await renameGenre('g-rock', 'Rock');
    expect(db.prepare(`SELECT count(*) n FROM genre_alias WHERE genre_id = 'g-rock'`).get()).toEqual({ n: 0 });
  });

  it('merges into a genre that already has the new name', async () => {
    const { renameGenre } = await import('./genres');
    insert(db, 'genre', [{ id: 'g-hh2', name: 'hip-hop', parent_id: null }]);
    insert(db, 'genre', [{ id: 'g-hh', name: 'hip hop', parent_id: null }]);
    insert(db, 'genre', [{ id: 'g-trap', name: 'trap', parent_id: 'g-hh' }]);
    insert(db, 'genre_tag', [{ entity_type: 'release_group', entity_id: 'rg-c', genre_id: 'g-hh', source: 'musicbrainz', weight: 1 }]);
    expect(await renameGenre('g-hh', 'hip-hop')).toBe('g-hh2');
    expect(db.prepare(`SELECT count(*) n FROM genre WHERE id = 'g-hh'`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT parent_id FROM genre WHERE id = 'g-trap'`).get()).toEqual({ parent_id: 'g-hh2' });
    expect(db.prepare(`SELECT genre_id FROM genre_tag WHERE entity_id = 'rg-c' AND source = 'musicbrainz' AND genre_id = 'g-hh2'`).get()).toBeDefined();
    expect(db.prepare(`SELECT genre_id FROM genre_alias WHERE name = 'hip hop'`).get()).toEqual({ genre_id: 'g-hh2' });
  });
});
