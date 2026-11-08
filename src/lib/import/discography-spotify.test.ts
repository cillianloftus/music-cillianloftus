import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../../test/d1';
import { insert, migratedDb, seedLibrary } from '../../test/db';
import { queueSpotifyDiscography, spotifyKind, type Kind } from './discography';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

const id = (s: string) => s.padEnd(22, 'x');
const release = (key: string, name: string, album_type: 'album' | 'single' | 'compilation', total_tracks: number, release_date: string) => ({
  id: id(key),
  name,
  album_type,
  total_tracks,
  release_date,
});

/** Spotify answering an artist's releases two pages at a time. */
function fakeSpotify() {
  const all = [
    release('lp2', 'Second Record', 'album', 11, '2023-05-01'),
    release('lp1', 'First Record', 'album', 9, '2020-02-01'),
    release('ep1', 'Four Songs', 'single', 4, '2021-01-01'),
    release('sg1', 'A Single', 'single', 1, '2022-01-01'),
    release('fut', 'Next Year', 'album', 10, '2999-01-01'),
  ];
  const asked: string[] = [];
  return {
    asked,
    client: {
      async get<T>(path: string): Promise<T> {
        asked.push(path);
        if (path === `/artists/${id('art')}`) return { name: 'Small Artist' } as T;
        const offset = Number(/offset=(\d+)/.exec(path)?.[1] ?? 0);
        const items = all.slice(offset, offset + 2);
        const next = offset + 2 < all.length ? `https://api.spotify.com/v1/artists/${id('art')}/albums?limit=2&offset=${offset + 2}` : null;
        return { items, next } as T;
      },
    },
  };
}

const kinds = (...k: Kind[]) => new Set<Kind>(k);

describe('a discography from Spotify, for artists MusicBrainz lacks', () => {
  it('reads Spotify’s kinds as ours', () => {
    expect(spotifyKind({ album_type: 'single', total_tracks: 4, name: 'x' })).toBe('ep');
    expect(spotifyKind({ album_type: 'single', total_tracks: 2, name: 'x' })).toBe('single');
    expect(spotifyKind({ album_type: 'album', total_tracks: 12, name: 'Live at the Olympia' })).toBe('live');
    expect(spotifyKind({ album_type: 'compilation', total_tracks: 12, name: 'x' })).toBe('compilation');
  });

  it('queues every page’s wanted releases, oldest first, nothing unreleased', async () => {
    const { client, asked } = fakeSpotify();
    const result = await queueSpotifyDiscography(id('art'), kinds('album', 'ep'), client);
    expect(result.name).toBe('Small Artist');
    expect(result.queued.map((q) => q.title)).toEqual(['First Record', 'Four Songs', 'Second Record']);
    expect(asked.filter((p) => p.includes('/albums')).length).toBe(3);
    const jobs = db.prepare(`SELECT payload_json AS payload FROM job ORDER BY rowid`).all() as { payload: string }[];
    expect(jobs.map((j) => JSON.parse(j.payload).target)).toEqual([
      { kind: 'album', id: id('lp1') },
      { kind: 'album', id: id('ep1') },
      { kind: 'album', id: id('lp2') },
    ]);
  });

  it('skips what is already here', async () => {
    insert(db, 'release_group', [{ id: 'rg-held', title: 'First Record', type: 'album', status: 'released', date_precision: 'unknown', source: 'spotify', spotify_id: id('lp1') }]);
    const result = await queueSpotifyDiscography(id('art'), kinds('album', 'ep'), fakeSpotify().client);
    expect(result.queued.map((q) => q.title)).toEqual(['Four Songs', 'Second Record']);
    expect(result.skipped).toBe(1);
  });
});
