import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../../test/d1';
import { insert, migratedDb, seedLibrary } from '../../test/db';
import { listenTrack } from './keys';
import { catalogueIndex } from './match';
import { rematchListens, savePlays, saveTracks } from './store';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

const SPOTIFY_ID = '4uLU6hMCjMI75M1A2tKUQC';
const exportTrack = listenTrack({ artist: 'Xavier', title: 'Song A1', album: 'Album A', spotify_id: SPOTIFY_ID });
const scrobbleTrack = listenTrack({ artist: 'Xavier feat. Yolanda', title: 'Song A1' });

const at = (minutes: number) => new Date(Date.parse('2026-10-03T20:00:00Z') + minutes * 60_000).toISOString();
const streams = (n: number) => Array.from({ length: n }, (_, i) => ({ track_key: exportTrack.key, played_at: at(i * 4), ms_played: 230_000 }));
const scrobbles = (n: number) => Array.from({ length: n }, (_, i) => ({ track_key: scrobbleTrack.key, played_at: at(i * 4 + 0.05), ms_played: null }));

const counts = () =>
  db.prepare(`SELECT source, sum(counted) AS counted, count(*) AS kept FROM play GROUP BY source ORDER BY source`).all();

describe('saving listens from two sources', () => {
  beforeEach(async () => {
    await saveTracks([exportTrack, scrobbleTrack], await catalogueIndex());
  });

  it('counts each moment once when the export comes after the scrobbles', async () => {
    await savePlays('u-owner', 'lastfm', scrobbles(3));
    expect(counts()).toEqual([{ source: 'lastfm', counted: 3, kept: 3 }]);
    await savePlays('u-owner', 'spotify_export', streams(3));
    expect(counts()).toEqual([
      { source: 'lastfm', counted: 0, kept: 3 },
      { source: 'spotify_export', counted: 3, kept: 3 },
    ]);
  });

  it('counts each moment once when the scrobbles come after the export', async () => {
    await savePlays('u-owner', 'spotify_export', streams(3));
    await savePlays('u-owner', 'lastfm', scrobbles(4)); // one more than streamed: Last.fm saw a play the export did not
    expect(counts()).toEqual([
      { source: 'lastfm', counted: 1, kept: 4 },
      { source: 'spotify_export', counted: 3, kept: 3 },
    ]);
    const copies = db.prepare(`SELECT count(*) AS n FROM play WHERE duplicate_of IS NOT NULL`).get();
    expect(copies).toEqual({ n: 3 });
  });

  it('never pairs one listener’s plays with another’s', async () => {
    await savePlays('u-owner', 'spotify_export', streams(1));
    await savePlays('u-friend', 'lastfm', scrobbles(1));
    expect(db.prepare(`SELECT count(*) AS n FROM play WHERE counted = 1`).get()).toEqual({ n: 2 });
  });
});

describe('listens outside the catalogue', () => {
  it('are kept, and join their recording once it is imported', async () => {
    const track = listenTrack({ artist: 'Zed', title: 'Later Song' });
    await saveTracks([track], await catalogueIndex());
    await savePlays('u-owner', 'lastfm', [{ track_key: track.key, played_at: at(0), ms_played: null }]);
    expect(db.prepare(`SELECT recording_id, counted FROM play`).get()).toEqual({ recording_id: null, counted: 1 });

    insert(db, 'artist', [{ id: 'art-z', name: 'Zed', sort_name: 'Zed', source: 'manual' }]);
    insert(db, 'recording', [{ id: 'z1', title: 'Later Song', source: 'manual' }]);
    insert(db, 'artist_credit', [{ id: 'c-z1', entity_type: 'recording', entity_id: 'z1', artist_id: 'art-z', role: 'primary' }]);
    expect(await rematchListens(await catalogueIndex())).toBe(1);
    expect(db.prepare(`SELECT recording_id FROM play`).get()).toEqual({ recording_id: 'z1' });
    expect(db.prepare(`SELECT recording_id FROM listen_track WHERE key = ?`).get(track.key)).toEqual({ recording_id: 'z1' });
  });
});
