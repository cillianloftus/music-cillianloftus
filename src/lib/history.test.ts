import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';
import { addPlays, divergence, historySummary, matchTracks, playCounts, playsRequest } from './history';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

const uri = (n: number) => `spotify:track:${String(n).padStart(22, '0')}`;

describe('matching', () => {
  it('matches by Spotify id first, then title and primary artist', async () => {
    db.exec(`UPDATE recording SET spotify_id = '${uri(1).slice(14)}' WHERE id = 'b1'`);
    const matches = await matchTracks([
      { uri: uri(1), name: 'Renamed On Spotify', artist: 'Someone Else', album: null },
      { uri: uri(2), name: 'Song A2 - 2015 Remaster', artist: 'xavier', album: 'Album A' },
      { uri: uri(3), name: 'Not In The Catalogue', artist: 'Xavier', album: null },
      { uri: uri(4), name: 'Song A2', artist: 'Yolanda', album: null }, // right title, wrong artist
    ]);
    expect(matches).toEqual({
      [uri(1)]: { recording_id: 'b1', how: 'spotify_id' },
      [uri(2)]: { recording_id: 'a2', how: 'title_artist' },
    });
  });

  it('prefers the recording on the album named when titles collide', async () => {
    insert(db, 'recording', [{ id: 'a2-live', title: 'Song A2', source: 'manual' }]);
    insert(db, 'release_group', [{ id: 'rg-live', title: 'Live Album', type: 'live', source: 'manual' }]);
    insert(db, 'release', [{ id: 'r-live', release_group_id: 'rg-live', title: 'Live Album', source: 'manual' }]);
    insert(db, 'track', [{ id: 't-live', release_id: 'r-live', recording_id: 'a2-live', position: 1 }]);
    insert(db, 'artist_credit', [{ id: 'c-live', entity_type: 'recording', entity_id: 'a2-live', artist_id: 'art-x', role: 'primary' }]);

    const matches = await matchTracks([{ uri: uri(5), name: 'Song A2', artist: 'Xavier', album: 'Live Album' }]);
    expect(matches[uri(5)]!.recording_id).toBe('a2-live');
  });
});

describe('plays', () => {
  const play = (recording_id: string, played_at: string, ms_played = 200_000) => ({ recording_id, played_at, ms_played });

  it('adds plays once, however often the same export is imported', async () => {
    const plays = [play('a1', '2025-01-01T10:00:00Z'), play('a1', '2025-01-02T10:00:00Z'), play('b1', '2025-01-01T11:00:00Z')];
    expect(await addPlays('u-owner', plays)).toBe(3);
    expect(await addPlays('u-owner', plays)).toBe(0);
    expect(await historySummary('u-owner')).toMatchObject({ plays: 3, recordings: 2, first: '2025-01-01T10:00:00Z', last: '2025-01-02T10:00:00Z' });
  });

  it('counts plays per recording, for that listener only', async () => {
    await addPlays('u-owner', [play('a1', '2025-01-01T10:00:00Z'), play('a1', '2025-01-02T10:00:00Z'), play('b1', '2025-01-01T11:00:00Z')]);
    await addPlays('u-friend', [play('a1', '2025-03-01T10:00:00Z')]);
    expect(await playCounts('u-owner', ['a1', 'b1', 'c1'])).toEqual(new Map([['a1', 2], ['b1', 1]]));
    expect(await playCounts('u-owner', [])).toEqual(new Map());
  });

  it('ignores a play naming no recording', async () => {
    expect(await addPlays('u-owner', [play('nope', '2025-01-01T10:00:00Z')])).toBe(0);
  });

  it('rejects skips and malformed rows at the boundary', () => {
    expect(playsRequest.safeParse({ plays: [play('a1', '2025-01-01T10:00:00Z', 5_000)] }).success).toBe(false);
    expect(playsRequest.safeParse({ plays: [play('a1', 'yesterday')] }).success).toBe(false);
    expect(playsRequest.safeParse({ plays: [{ ...play('a1', '2025-01-01T10:00:00Z'), user_id: 'u-friend' }] }).success).toBe(false);
  });
});

describe('divergence', () => {
  it('finds loved but unplayed tracks, and played but unloved ones', async () => {
    // Scores (seed): a4 100, c1 95, a1 90, b1 80, a2 70, b2 60, a3 50.
    const plays: { recording_id: string; played_at: string; ms_played: number }[] = [];
    const listen = (id: string, n: number) => {
      for (let i = 0; i < n; i++) plays.push({ recording_id: id, played_at: `2025-01-01T00:${String(i).padStart(2, '0')}:00Z`, ms_played: 60_000 });
    };
    listen('a3', 40); // lowest scored, most played
    listen('b2', 20);
    listen('a2', 10);
    listen('b1', 5);
    listen('a1', 3);
    listen('c1', 1); // c1 95 and a4 100: barely played
    await addPlays('u-owner', plays);

    const { underplayed, overplayed } = await divergence('u-owner');
    // Perfectly anti-correlated, so the gap orders both lists end to end.
    expect(underplayed.map((d) => d.recording_id)).toEqual(['a4', 'c1', 'a1']);
    expect(overplayed.map((d) => d.recording_id)).toEqual(['a3', 'b2', 'a2']);
    expect(overplayed[0]).toMatchObject({ title: 'Song A3', plays: 40, artist: 'Xavier', album_title: 'Album A' });
  });

  it('says nothing for a library too small to compare', async () => {
    db.exec(`DELETE FROM play`);
    const fresh = migratedDb();
    seedLibrary(fresh);
    (env as { DB: D1Database }).DB = d1(fresh);
    insert(fresh, 'app_user', [{ id: 'u-new', email: 'new@example.com', display_name: 'New', is_owner: 0 }]);
    expect(await divergence('u-new')).toEqual({ underplayed: [], overplayed: [] });
  });
});
