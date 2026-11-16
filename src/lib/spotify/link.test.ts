import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { d1 } from '../../test/d1';
import { migratedDb, seedLibrary } from '../../test/db';
import type { SpotifyClient } from './client';
import { pickAlbum, preferExplicitEditions } from './link';

describe('an album linked to its clean edition', () => {
  it('is switched to the explicit one, its songs with it', async () => {
    const db = migratedDb();
    seedLibrary(db);
    (env as { DB: D1Database }).DB = d1(db);
    // Album B (Xavier, 2020) linked to Spotify's clean edition, its songs to the clean tracks.
    db.prepare(`UPDATE release_group SET spotify_id = 'clean' WHERE id = 'rg-b'`).run();
    db.prepare(`UPDATE recording SET spotify_id = 'c1' WHERE id = 'b1'`).run();
    db.prepare(`UPDATE recording SET spotify_id = 'c2' WHERE id = 'b2'`).run();
    const edition = (id: string) => ({ id, name: 'Album B', album_type: 'album', release_date: '2020-05-01', total_tracks: 2, artists: [{ name: 'Xavier' }] });
    const tracks = (prefix: string, explicit: boolean) => [1, 2].map((n) => ({ id: `${prefix}${n}`, name: `Song B${n}`, disc_number: 1, track_number: n, explicit }));
    const spotify = {
      get: async (path: string) => {
        if (path.startsWith('/search')) return { albums: { items: [edition('clean'), edition('original')] } };
        if (path.startsWith('/albums/clean/tracks')) return { items: tracks('c', false) };
        if (path.startsWith('/albums/original/tracks')) return { items: tracks('o', true) };
        throw new Error(path);
      },
    } as unknown as SpotifyClient;

    expect(await preferExplicitEditions(spotify)).toBe(1);
    expect(db.prepare(`SELECT spotify_id FROM release_group WHERE id = 'rg-b'`).get()).toEqual({ spotify_id: 'original' });
    expect(db.prepare(`SELECT id, spotify_id FROM recording WHERE id IN ('b1', 'b2') ORDER BY id`).all()).toEqual([
      { id: 'b1', spotify_id: 'o1' },
      { id: 'b2', spotify_id: 'o2' },
    ]);
    // Checked: not asked about again tonight.
    expect(await preferExplicitEditions(spotify)).toBe(0);
  });
});

const hit = (name: string, overrides: Record<string, unknown> = {}) => ({
  id: name,
  name,
  album_type: 'album',
  release_date: '2025-03-21',
  total_tracks: 14,
  artists: [{ name: 'Quadeca' }],
  ...overrides,
});
const album = { title: 'Vanisher, Horizon Scraper', artist: 'Quadeca', first_release_date: '2025-03-21', track_count: 14 };

describe('pickAlbum', () => {
  it('takes the album with the same title and artist', () => {
    expect(pickAlbum(album, [hit('Something Else'), hit('Vanisher, Horizon Scraper')])?.id).toBe('Vanisher, Horizon Scraper');
  });

  it('prefers the standard edition over a deluxe one, by length', () => {
    const deluxe = hit('Vanisher, Horizon Scraper (Deluxe)', { id: 'deluxe', total_tracks: 18 });
    const standard = hit('Vanisher, Horizon Scraper', { id: 'standard' });
    expect(pickAlbum(album, [deluxe, standard])?.id).toBe('standard');
  });

  it('never takes a compilation, another artist, or a near title', () => {
    expect(pickAlbum(album, [hit('Vanisher, Horizon Scraper', { album_type: 'compilation' })])).toBeNull();
    expect(pickAlbum(album, [hit('Vanisher, Horizon Scraper', { artists: [{ name: 'Someone' }] })])).toBeNull();
    expect(pickAlbum(album, [hit('Vanisher')])).toBeNull();
  });
});
