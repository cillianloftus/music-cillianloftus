import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../../test/d1';
import { migratedDb, seedLibrary } from '../../test/db';
import type { SpotifyClient } from './client';
import { findEditionOnSpotify } from './link';

let db: DatabaseSync;
const hit = (id: string, name: string, total_tracks: number) => ({ id, name, album_type: 'album', release_date: '2026-02-03', total_tracks, artists: [{ name: 'Xavier' }] });

/** Spotify's search, answering with these albums whatever is asked; tracks asked for are none. */
const fake = (albums: ReturnType<typeof hit>[]) =>
  ({
    get: async (path: string) => (path.startsWith('/search') ? { albums: { items: albums } } : { items: [] }),
  }) as unknown as SpotifyClient;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
  db.exec(`UPDATE release_group SET spotify_id = 'sp-standard' WHERE id = 'rg-a'`);
  db.exec(`UPDATE release SET note = 'The Extended Cut' WHERE id = 'r-a-deluxe'`);
});

const spotifyOf = (id: string) => (db.prepare(`SELECT spotify_id FROM release WHERE id = ?`).get(id) as { spotify_id: string | null }).spotify_id;

describe('an edition found on Spotify by itself', () => {
  it('is the one named for it, never the album already linked', async () => {
    const found = await findEditionOnSpotify(
      fake([hit('sp-standard', 'Album A', 3), hit('sp-deluxe', 'Album A (Deluxe)', 3), hit('sp-ext', 'Album A (The Extended Cut)', 9)]),
      'r-a-deluxe',
    );
    expect(found).toBe('sp-ext');
    expect(spotifyOf('r-a-deluxe')).toBe('sp-ext');
  });

  it('is the one with its track count when it has no name of its own', async () => {
    db.exec(`UPDATE release SET note = NULL WHERE id = 'r-a-deluxe'`);
    const count = (db.prepare(`SELECT count(*) n FROM track WHERE release_id = 'r-a-deluxe'`).get() as { n: number }).n;
    expect(await findEditionOnSpotify(fake([hit('sp-other', 'Album A (Live)', 20), hit('sp-four', 'Album A (Deluxe)', count)]), 'r-a-deluxe')).toBe('sp-four');
  });

  it('is nothing when nothing matches', async () => {
    db.exec(`UPDATE release SET note = NULL WHERE id = 'r-a-deluxe'`);
    expect(await findEditionOnSpotify(fake([hit('sp-x', 'Another Album', 3)]), 'r-a-deluxe')).toBeNull();
    expect(spotifyOf('r-a-deluxe')).toBeNull();
  });
});
