import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { migratedDb, seedLibrary } from '../test/db';
import { fillPopularity } from './popularity';
import { fillAlbumSoundFromDeezer, fillSoundFromDeezer } from './sources/deezer';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

const deezer = (async (url: string) => {
  const path = new URL(url).pathname;
  const json = path.startsWith('/search/album')
    ? { data: [{ id: 9, title: 'Album A', artist: { name: 'Xavier' } }] }
    : path === '/album/9/tracks'
      ? {
          data: [
            { id: 101, title: 'Song A1', isrc: 'GBAAA2600001', track_position: 1, disk_number: 1, rank: 500000, explicit_lyrics: true },
            { id: 102, title: 'Something Else', track_position: 2, disk_number: 1, rank: 10 },
            { id: 103, title: 'Song A3 (2016 Remaster)', title_short: 'Song A3', track_position: 3, disk_number: 1, rank: 20, explicit_lyrics: false },
          ],
        }
      : path === '/album/9'
        ? { id: 9, title: 'Album A' }
        : path === '/track/isrc:GBBBB2600001'
          ? { id: 201, title: 'Song B1', isrc: 'GBBBB2600001', track_position: 4, disk_number: 1, rank: 7 }
          : path === '/track/201'
            ? { bpm: 90, gain: -11 }
        : path === '/track/101'
          ? { bpm: 120.04, gain: -8.2 }
          : path === '/track/103'
            ? { bpm: 0, gain: -2 }
            : { error: { code: 800 } };
  return new Response(JSON.stringify(json));
}) as typeof fetch;

const sound = (id: string) => db.prepare(`SELECT bpm, loudness, explicit, isrc, deezer_id FROM recording WHERE id = ?`).get(id);

describe('tempo and loudness from Deezer', () => {
  it('matches tracks by position and title, fills what is missing, and keeps a tempo Deezer does not know as unknown', async () => {
    expect(await fillSoundFromDeezer('rg-a', deezer)).toEqual({ matched: 2, tempos: 1 });
    expect(sound('a1')).toEqual({ bpm: 120, loudness: -8.2, explicit: 1, isrc: 'GBAAA2600001', deezer_id: 101 });
    // Same position, another title: not taken for it.
    expect(sound('a2')).toEqual({ bpm: null, loudness: null, explicit: null, isrc: null, deezer_id: null });
    expect(sound('a3')).toEqual({ bpm: null, loudness: -2, explicit: 0, isrc: null, deezer_id: 103 });
  });

  it('finds a track by ISRC when Deezer does not have its album under that name', async () => {
    db.exec(`UPDATE recording SET isrc = 'GBBBB2600001' WHERE id = 'b1'`);
    expect(await fillSoundFromDeezer('rg-b', deezer)).toEqual({ matched: 1, tempos: 1 });
    expect(sound('b1')).toEqual({ bpm: 90, loudness: -11, explicit: null, isrc: 'GBBBB2600001', deezer_id: 201 });
  });

  it('looks at each album once: one that matched never again, one that did not after three months', async () => {
    expect(await fillAlbumSoundFromDeezer({ budgetMs: 5000, fetcher: deezer })).toMatchObject({ albums: 3, matched: 2, left: 0 });
    expect((await fillAlbumSoundFromDeezer({ budgetMs: 5000, fetcher: deezer })).albums).toBe(0);
    db.exec(`UPDATE lookup_log SET looked_at = datetime('now', '-100 days') WHERE source = 'deezer-tracks'`);
    // Album A matched; B and C found nothing on Deezer and are asked again.
    expect((await fillAlbumSoundFromDeezer({ budgetMs: 5000, fetcher: deezer })).albums).toBe(2);
  });
});

describe('popularity from ListenBrainz', () => {
  it('keeps everyone’s listens for tracks it knows, and asks about each once a month', async () => {
    db.exec(`UPDATE recording SET mbid = 'mb-' || id WHERE id IN ('a1', 'a2')`);
    const asked: string[][] = [];
    const listenbrainz = (async (_url: string, init?: RequestInit) => {
      const { recording_mbids } = JSON.parse(String(init?.body)) as { recording_mbids: string[] };
      asked.push(recording_mbids);
      return new Response(
        JSON.stringify(
          recording_mbids.map((m) => ({ recording_mbid: m, total_listen_count: m === 'mb-a1' ? 1234 : null, total_user_count: m === 'mb-a1' ? 56 : null })),
        ),
      );
    }) as typeof fetch;
    expect(await fillPopularity({ budgetMs: 5000, fetcher: listenbrainz })).toEqual({ looked: 2, found: 1, left: 0 });
    expect(db.prepare(`SELECT listen_count, listener_count FROM recording WHERE id = 'a1'`).get()).toEqual({ listen_count: 1234, listener_count: 56 });
    expect(asked).toHaveLength(1);
    expect((await fillPopularity({ budgetMs: 5000, fetcher: listenbrainz })).looked).toBe(0);
  });
});
