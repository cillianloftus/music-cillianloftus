import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';
import { cosine, kinOf } from './kin';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

describe('artists close to another', () => {
  it('measures genre likeness', () => {
    expect(cosine(new Map([['a', 1]]), new Map([['a', 3]]))).toBeCloseTo(1);
    expect(cosine(new Map([['a', 1]]), new Map([['b', 1]]))).toBe(0);
  });

  it('finds an artist with the same genres and people, and says why', async () => {
    insert(db, 'artist', [{ id: 'art-z', name: 'Zed', sort_name: 'Zed', source: 'manual' }]);
    insert(db, 'release_group', [{ id: 'rg-z', title: 'Zed LP', type: 'album', source: 'manual' }]);
    insert(db, 'recording', [{ id: 'z1', title: 'Zed One', source: 'manual' }]);
    insert(db, 'artist_credit', [
      { id: 'cz1', entity_type: 'release_group', entity_id: 'rg-z', artist_id: 'art-z', role: 'primary' },
      { id: 'cz2', entity_type: 'recording', entity_id: 'z1', artist_id: 'art-z', role: 'primary' },
      // Pat produced for Xavier too.
      { id: 'cz3', entity_type: 'recording', entity_id: 'z1', artist_id: 'art-p', role: 'producer' },
    ]);
    insert(db, 'genre_tag', [{ entity_type: 'release_group', entity_id: 'rg-z', genre_id: 'g-indie', source: 'manual', weight: 1 }]);
    const kin = await kinOf('art-x');
    expect(kin[0]).toMatchObject({ id: 'art-z', sharedGenres: ['indie pop'], sharedPeople: [{ id: 'art-p', name: 'Pat Producer' }] });
    // Yolanda shares neither.
    expect(kin.some((k) => k.id === 'art-y')).toBe(false);
  });
});
