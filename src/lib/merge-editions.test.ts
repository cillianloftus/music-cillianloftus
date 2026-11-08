import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';
import { mergeAlbums } from './merge';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

const canonical = (album: string) =>
  (db.prepare(`SELECT release_id FROM v_release_group_canonical WHERE release_group_id = ?`).get(album) as { release_id: string }).release_id;

describe('the standard edition', () => {
  it('is the plainly titled one, even when a deluxe is dated earlier', () => {
    db.exec(`UPDATE release SET date = '2014', date_precision = 'year' WHERE id = 'r-a-deluxe'`);
    expect(canonical('rg-a')).toBe('r-a');
    // A hand choice still wins.
    db.exec(`UPDATE release_group SET preferred_release_id = 'r-a-deluxe' WHERE id = 'rg-a'`);
    expect(canonical('rg-a')).toBe('r-a-deluxe');
  });
});

describe('merging albums makes editions, folding duplicates', () => {
  /** Album A's deluxe again, imported from Spotify as an album of its own, with its own copies of the songs. */
  function seedSpotifyDeluxe() {
    insert(db, 'release_group', [{ id: 'rg-x', title: 'Album A (Deluxe Edition)', type: 'album', source: 'spotify' }]);
    insert(db, 'release', [{ id: 'r-x', release_group_id: 'rg-x', title: 'Album A (Deluxe Edition)', date: '2014', date_precision: 'year', source: 'spotify', spotify_id: 'sp-x' }]);
    insert(db, 'recording', [
      { id: 'x1', title: 'Song A1', source: 'spotify' },
      { id: 'x2', title: 'Song A2', source: 'spotify' },
      { id: 'x3', title: 'SONG A3', source: 'spotify' },
      { id: 'x4', title: 'Bonus A4', source: 'spotify' },
    ]);
    insert(db, 'track', [
      { id: 't-x1', release_id: 'r-x', recording_id: 'x1', position: 1 },
      { id: 't-x2', release_id: 'r-x', recording_id: 'x2', position: 2 },
      { id: 't-x3', release_id: 'r-x', recording_id: 'x3', position: 3 },
      { id: 't-x4', release_id: 'r-x', recording_id: 'x4', position: 4 },
    ]);
    insert(db, 'rating', [
      { id: 'r-x2', user_id: 'u-owner', entity_type: 'recording', entity_id: 'x2', depth: 'gut', gut_score: 2, rated_at: '2026-04-01T00:00:00.000Z' },
    ]);
  }

  it('the same deluxe twice becomes one edition, its songs merged into the album’s', async () => {
    seedSpotifyDeluxe();
    await mergeAlbums('rg-a', 'rg-x');

    const editions = db.prepare(`SELECT id FROM release WHERE release_group_id = 'rg-a' ORDER BY id`).all();
    expect(editions).toEqual([{ id: 'r-a' }, { id: 'r-a-deluxe' }]);
    // The Spotify copy's link fills the kept edition's gap.
    expect(db.prepare(`SELECT spotify_id FROM release WHERE id = 'r-a-deluxe'`).get()).toEqual({ spotify_id: 'sp-x' });
    expect(db.prepare(`SELECT count(*) n FROM recording WHERE id IN ('x1', 'x2', 'x3', 'x4')`).get()).toEqual({ n: 0 });
    // A rating on the Spotify copy of a song now belongs to the album's song.
    expect(db.prepare(`SELECT entity_id FROM rating WHERE id = 'r-x2'`).get()).toEqual({ entity_id: 'a2' });
    expect(db.prepare(`SELECT new_id FROM entity_redirect WHERE entity_type = 'release' AND old_id = 'r-x'`).get()).toEqual({ new_id: 'r-a-deluxe' });
    expect(canonical('rg-a')).toBe('r-a');
  });

  it('an edition with a different tracklist stays an edition of its own', async () => {
    seedSpotifyDeluxe();
    // Two tracks only: no edition here has that tracklist.
    db.exec(`DELETE FROM track WHERE id IN ('t-x3', 't-x4')`);
    await mergeAlbums('rg-a', 'rg-x');
    expect(db.prepare(`SELECT count(*) n FROM release WHERE release_group_id = 'rg-a'`).get()).toEqual({ n: 3 });
  });
});

describe('an album dates from its earliest edition', () => {
  it('moves back when an earlier edition joins, but never over a hand-set date', async () => {
    const { albumDateFromEditions } = await import('./editions');
    db.exec(`UPDATE release SET date = '2013-05-01', date_precision = 'day' WHERE id = 'r-a-deluxe'`);
    await albumDateFromEditions('rg-a');
    expect(db.prepare(`SELECT first_release_date d FROM release_group WHERE id = 'rg-a'`).get()).toEqual({ d: '2013-05-01' });
    // Later editions never move it forward.
    db.exec(`UPDATE release SET date = '2019', date_precision = 'year' WHERE id = 'r-a-deluxe'`);
    await albumDateFromEditions('rg-a');
    expect(db.prepare(`SELECT first_release_date d FROM release_group WHERE id = 'rg-a'`).get()).toEqual({ d: '2013-05-01' });
    // Set by hand: left alone.
    insert(db, 'field_override', [
      { entity_type: 'release_group', entity_id: 'rg-b', field: 'first_release_date', value_json: '{"date":"2020","precision":"year"}', user_id: 'u-owner' },
    ]);
    db.exec(`UPDATE release SET date = '2001', date_precision = 'year' WHERE id = 'r-b'`);
    await albumDateFromEditions('rg-b');
    expect(db.prepare(`SELECT first_release_date d FROM release_group WHERE id = 'rg-b'`).get()).toEqual({ d: '2020' });
  });
});
