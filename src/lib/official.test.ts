import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';
import { artistsToCheck, markArtistGroups, removedMbids, removeReleaseGroup, removeUnofficial, RemovalError, unofficialGroups } from './official';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

const count = (sql: string, ...params: string[]) => (db.prepare(sql).get(...params) as { n: number }).n;

/** A fan-made "album" by Xavier: one song also on Album A, one only here, one only here but rated. */
function seedBootleg() {
  insert(db, 'release_group', [{ id: 'rg-boot', title: 'THE BOOTLEG', type: 'album', mbid: 'mb-boot', source: 'musicbrainz', official: 0 }]);
  insert(db, 'release', [{ id: 'r-boot', release_group_id: 'rg-boot', title: 'THE BOOTLEG', source: 'musicbrainz' }]);
  insert(db, 'recording', [
    { id: 'boot1', title: 'Leak', source: 'musicbrainz' },
    { id: 'boot2', title: 'Rated leak', source: 'musicbrainz' },
  ]);
  insert(db, 'track', [
    { id: 't-boot-a2', release_id: 'r-boot', recording_id: 'a2', position: 1 },
    { id: 't-boot1', release_id: 'r-boot', recording_id: 'boot1', position: 2 },
    { id: 't-boot2', release_id: 'r-boot', recording_id: 'boot2', position: 3 },
  ]);
  db.exec(`UPDATE release_group SET preferred_release_id = 'r-boot' WHERE id = 'rg-boot'`);
  insert(db, 'artist_credit', [
    { id: 'c-boot', entity_type: 'release_group', entity_id: 'rg-boot', artist_id: 'art-x', role: 'primary' },
    { id: 'c-boot1', entity_type: 'recording', entity_id: 'boot1', artist_id: 'art-x', role: 'primary' },
  ]);
  insert(db, 'genre_tag', [{ entity_type: 'release_group', entity_id: 'rg-boot', genre_id: 'g-pop', source: 'musicbrainz', weight: 1 }]);
  insert(db, 'rating', [
    { id: 'r-boot2', user_id: 'u-owner', entity_type: 'recording', entity_id: 'boot2', depth: 'gut', gut_score: 4, rated_at: '2026-02-01T00:00:00.000Z' },
  ]);
  insert(db, 'anomaly', [{ id: 'an-boot', kind: 'missing_cover_art', entity_type: 'release_group', entity_a: 'rg-boot', status: 'open' }]);
}

describe('removing an album', () => {
  it('takes the album, its editions, tracks and what is only its, and keeps a snapshot', async () => {
    seedBootleg();
    await removeReleaseGroup('rg-boot', 'unofficial');

    expect(count(`SELECT count(*) n FROM release_group WHERE id = 'rg-boot'`)).toBe(0);
    expect(count(`SELECT count(*) n FROM release WHERE id = 'r-boot'`)).toBe(0);
    expect(count(`SELECT count(*) n FROM track WHERE release_id = 'r-boot'`)).toBe(0);
    // Only on the bootleg and unrated: gone, with its credit and search entry.
    expect(count(`SELECT count(*) n FROM recording WHERE id = 'boot1'`)).toBe(0);
    expect(count(`SELECT count(*) n FROM artist_credit WHERE entity_id IN ('boot1', 'rg-boot')`)).toBe(0);
    expect(count(`SELECT count(*) n FROM search_index WHERE entity_id IN ('boot1', 'rg-boot')`)).toBe(0);
    expect(count(`SELECT count(*) n FROM genre_tag WHERE entity_id = 'rg-boot'`)).toBe(0);
    expect(count(`SELECT count(*) n FROM anomaly WHERE entity_a = 'rg-boot'`)).toBe(0);
    // On Album A too, or rated: stays.
    expect(count(`SELECT count(*) n FROM recording WHERE id IN ('a2', 'boot2')`)).toBe(2);
    expect(count(`SELECT count(*) n FROM track WHERE recording_id = 'a2'`)).toBe(2);
    expect(count(`SELECT count(*) n FROM rating WHERE entity_id = 'boot2'`)).toBe(1);

    const removed = db.prepare(`SELECT * FROM removed_release_group WHERE id = 'rg-boot'`).get() as Record<string, string>;
    expect(removed.mbid).toBe('mb-boot');
    expect(removed.artist).toBe('Xavier');
    const snapshot = JSON.parse(removed.snapshot_json);
    expect(snapshot.track).toHaveLength(3);
    expect(snapshot.recording.map((r: { id: string }) => r.id)).toEqual(['boot1']);
    expect(snapshot.genre_tag).toHaveLength(1);
    expect([...(await removedMbids(['mb-boot', 'mb-other']))]).toEqual(['mb-boot']);
  });

  it('refuses an album that is rated or owned', async () => {
    insert(db, 'rating', [
      { id: 'r-album', user_id: 'u-owner', entity_type: 'release_group', entity_id: 'rg-b', depth: 'gut', gut_score: 7, rated_at: '2026-02-02T00:00:00.000Z' },
    ]);
    await expect(removeReleaseGroup('rg-b', 'unofficial')).rejects.toThrow(RemovalError);
    insert(db, 'holding', [{ id: 'h1', user_id: 'u-owner', release_id: 'r-c', format: 'vinyl' }]);
    await expect(removeReleaseGroup('rg-c', 'unofficial')).rejects.toThrow(/own a copy/);
    expect(count(`SELECT count(*) n FROM release_group WHERE id IN ('rg-b', 'rg-c')`)).toBe(2);
  });

  it('removes the unofficial ones in a batch, leaving rated ones listed', async () => {
    seedBootleg();
    db.exec(`UPDATE release_group SET official = 0 WHERE id = 'rg-b'`);
    insert(db, 'rating', [
      { id: 'r-album', user_id: 'u-owner', entity_type: 'release_group', entity_id: 'rg-b', depth: 'gut', gut_score: 7, rated_at: '2026-02-02T00:00:00.000Z' },
    ]);
    expect((await unofficialGroups()).map((g) => [g.id, g.blocked])).toEqual([
      ['rg-b', 'rated'],
      ['rg-boot', null],
    ]);
    expect(await removeUnofficial({ budgetMs: 10_000 })).toEqual({ removed: 1, left: 0 });
    expect((await unofficialGroups()).map((g) => g.id)).toEqual(['rg-b']);
  });
});

describe('checking against MusicBrainz', () => {
  it('marks an artist’s groups by whether MusicBrainz lists them as official', async () => {
    db.exec(`UPDATE release_group SET mbid = 'mb-' || id`);
    await markArtistGroups('art-x', ['mb-rg-a']);
    const rows = db.prepare(`SELECT id, official FROM release_group ORDER BY id`).all();
    expect(rows).toEqual([
      { id: 'rg-a', official: 1 },
      { id: 'rg-b', official: 0 },
      { id: 'rg-c', official: null },
    ]);
    expect(count(`SELECT count(*) n FROM artist WHERE id = 'art-x' AND releases_checked_at IS NOT NULL`)).toBe(1);
    // Shown official by another of its artists: stays official.
    db.exec(`UPDATE release_group SET official = 1 WHERE id = 'rg-b'`);
    await markArtistGroups('art-x', ['mb-rg-a']);
    expect(count(`SELECT official n FROM release_group WHERE id = 'rg-b'`)).toBe(1);
  });

  it('picks the artists of unchecked albums, then those checked longest ago, and none once all is settled', async () => {
    db.exec(`UPDATE release_group SET mbid = 'mb-' || id`);
    db.exec(`UPDATE artist SET mbid = 'mb-' || id`);
    const primaries = (db.prepare(`SELECT DISTINCT artist_id AS id FROM artist_credit WHERE entity_type = 'release_group' AND role = 'primary' ORDER BY artist_id`).all() as { id: string }[]).map((r) => r.id);
    expect(primaries.length).toBeGreaterThan(0);
    expect((await artistsToCheck(10)).map((a) => a.id).sort()).toEqual(primaries);
    expect(await artistsToCheck(1)).toHaveLength(1);

    for (const id of primaries) await markArtistGroups(id, []);
    expect(await artistsToCheck(10)).toEqual([]);

    // A check over ninety days old is due again.
    db.prepare(`UPDATE artist SET releases_checked_at = ? WHERE id = ?`).run(new Date(Date.now() - 120 * 86_400_000).toISOString(), primaries[0]!);
    expect((await artistsToCheck(10)).map((a) => a.id)).toEqual([primaries[0]]);
  });
});
