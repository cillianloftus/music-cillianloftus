import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { migratedDb, seedLibrary } from '../test/db';
import { addToAlbum, albumsForSong } from './add-to-album';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

// Album B's standard edition (r-b) holds b2 at 2 (and b1 at 1).
const order = () =>
  (db.prepare(`SELECT recording_id FROM track WHERE release_id = 'r-b' ORDER BY disc, position`).all() as { recording_id: string }[]).map((t) => t.recording_id);

describe('adding a song to an album by hand', () => {
  it('offers its artist’s albums it is not on', async () => {
    const offered = (await albumsForSong('a1')).map((a) => a.id);
    expect(offered).toContain('rg-b');
    expect(offered).not.toContain('rg-a');
  });

  it('puts it at the end, or at a track number with the rest moved down', async () => {
    const before = order();
    await addToAlbum('a1', 'rg-b');
    expect(order()).toEqual([...before, 'a1']);
    await addToAlbum('a2', 'rg-b', 1);
    expect(order()).toEqual(['a2', ...before, 'a1']);
  });

  it('refuses a song already on it', async () => {
    await expect(addToAlbum('b2', 'rg-b')).rejects.toThrow(/already on that album/);
  });
});
