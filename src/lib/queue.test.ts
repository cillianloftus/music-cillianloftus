import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';
import { ratingQueue, recordHandoff, skip } from './queue';

// Fixture (src/test/db.ts): no album ratings yet. Artist Y's only track
// scores 95, so Y is "rated highly"; X averages 75. Gut 8+ tracks: a1 9,
// a4 10, b1 8, c1 9.5. All albums were added just now.

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

const ids = async () => (await ratingQueue('u-owner')).map((entry) => entry.entity_id);

describe('rating queue', () => {
  it('orders by tier: highly rated artist, then gut 8+ to examine, then recently added', async () => {
    const queue = await ratingQueue('u-owner');
    expect(queue.map((e) => e.reason.tier)).toEqual([1, 3, 3, 3, 3, 4, 4]);
    expect(queue[0]).toMatchObject({ entity_id: 'rg-c', reason: { kind: 'artist', artist: 'Yolanda', score: 95 } });
    expect(queue.slice(1, 5).map((e) => e.entity_id).sort()).toEqual(['a1', 'a4', 'b1', 'c1']);
    expect(queue.slice(5).map((e) => e.entity_id).sort()).toEqual(['rg-a', 'rg-b']);
  });

  it('drops an album once it has an album rating', async () => {
    insert(db, 'rating', [{ id: 'r-rg-c', user_id: 'u-owner', entity_type: 'release_group', entity_id: 'rg-c', depth: 'gut', gut_score: 6 }]);
    expect(await ids()).not.toContain('rg-c');
  });

  it('drops a gut-rated track once it has a detailed rating', async () => {
    insert(db, 'rating', [
      { id: 'det', user_id: 'u-owner', entity_type: 'recording', entity_id: 'a1', depth: 'detailed', gut_score: 9, production: 9, rated_at: '2026-06-01T00:00:00.000Z' },
    ]);
    expect(await ids()).not.toContain('a1');
  });

  it('puts what was just opened in Spotify at the top, until it is rated', async () => {
    await recordHandoff('u-owner', 'release_group', 'rg-b');
    const queue = await ratingQueue('u-owner');
    expect(queue[0]).toMatchObject({ entity_id: 'rg-b', reason: { kind: 'handoff' } });

    insert(db, 'rating', [{ id: 'r-rg-b', user_id: 'u-owner', entity_type: 'release_group', entity_id: 'rg-b', depth: 'gut', gut_score: 7, rated_at: '2999-01-01T00:00:00.000Z' }]);
    expect(await ids()).not.toContain('rg-b');
  });

  it('a skip sinks an item to the bottom without hiding it', async () => {
    await skip('u-owner', 'release_group', 'rg-c');
    const queue = await ratingQueue('u-owner');
    expect(queue.at(-1)).toMatchObject({ entity_id: 'rg-c', skipped: true });
    expect(queue).toHaveLength(7);
  });

  it('counts repeated skips', async () => {
    await skip('u-owner', 'recording', 'a1');
    await skip('u-owner', 'recording', 'a1');
    expect(db.prepare("SELECT skip_count FROM queue_skip WHERE entity_id = 'a1'").get()!.skip_count).toBe(2);
  });

  it('brings in a song played often and never rated, most played first', async () => {
    // n2 and n3 are new and unrated (on album B); a1 is rated in the fixture.
    insert(db, 'recording', ['n2', 'n3'].map((id) => ({ id, title: `New ${id}`, source: 'manual' })));
    insert(db, 'track', ['n2', 'n3'].map((id, i) => ({ id: `t-${id}`, release_id: 'r-b', recording_id: id, position: 10 + i })));
    insert(db, 'listen_track', ['a1', 'n2', 'n3'].map((id) => ({ key: `recording:${id}`, artist: 'X', title: id, artist_key: 'x', title_key: id, recording_id: id })));
    const plays = (id: string, n: number, counted = 1) =>
      Array.from({ length: n }, (_, i) => ({
        id: `p-${id}-${i}-${counted}`,
        user_id: 'u-owner',
        track_key: `recording:${id}`,
        recording_id: id,
        played_at: `2026-0${counted ? 1 : 2}-01T00:${String(i).padStart(2, '0')}:00.000Z`,
        source: 'lastfm',
        counted,
      }));
    insert(db, 'play', [...plays('n2', 12), ...plays('n3', 9), ...plays('n3', 5, 0), ...plays('a1', 20)]);

    const queue = await ratingQueue('u-owner');
    const songs = queue.filter((e) => e.reason.kind === 'plays' && e.entity_type === 'recording');
    // n3 has 9 counted plays (the five under 30 seconds do not count); a1 is rated.
    expect(songs).toEqual([{ entity_type: 'recording', entity_id: 'n2', reason: { tier: 2, kind: 'plays', plays: 12 }, skipped: false }]);
    // Below the highly rated artist's album, above the tracks to examine.
    expect(queue.findIndex((e) => e.entity_id === 'n2')).toBeLessThan(queue.findIndex((e) => e.reason.kind === 'examine'));
    expect(queue[0]?.entity_id).toBe('rg-c');
  });

  it('is per user', async () => {
    // The friend has rated only b2 (10): an "examine" item for them, not the owner.
    const friend = await ratingQueue('u-friend');
    expect(friend.filter((e) => e.entity_type === 'recording').map((e) => e.entity_id)).toEqual(['b2']);
  });
});
