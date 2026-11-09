import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { d1 } from '../../test/d1';
import { insert, migratedDb, seedLibrary } from '../../test/db';
import { parseSpotifyInput, planFromSpotify, spotifyDate, type SpotifyAlbum } from '../spotify/album';
import type { SpotifyClient } from '../spotify/client';
import type { ImportPlan } from './plan';

const barcodeHits = vi.hoisted(() => ({ value: [] as { id: string; score: number; title: string }[] }));
const mbPlan = vi.hoisted(() => ({ value: null as ImportPlan | null }));
vi.mock('../musicbrainz/client', async (original) => ({
  ...(await original<typeof import('../musicbrainz/client')>()),
  releasesByBarcode: async () => barcodeHits.value,
}));
vi.mock('./musicbrainz', () => ({ planFromMusicBrainz: async () => mbPlan.value }));
vi.mock('./coverart', async (original) => ({
  ...(await original<typeof import('./coverart')>()),
  storeCoverArt: async () => null,
}));

const { importFromSpotify } = await import('./spotify');

let db: DatabaseSync;
const stored = new Map<string, unknown>();

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
  (env as { ASSET_STORE: unknown }).ASSET_STORE = { put: async (key: string, body: unknown) => void stored.set(key, body) };
  stored.clear();
  barcodeHits.value = [];
  mbPlan.value = null;
  vi.stubGlobal('fetch', async () => new Response(new Uint8Array([0xff, 0xd8]), { status: 200 }));
});

const id = (n: number | string) => String(n).padStart(22, 'x');

function album(overrides: Partial<SpotifyAlbum> = {}): SpotifyAlbum {
  const items = [
    { id: id('t1'), name: 'Opening', disc_number: 1, track_number: 1, duration_ms: 180000, artists: [{ id: id('ax'), name: 'Xavier' }] },
    { id: id('t2'), name: 'Duet', disc_number: 1, track_number: 2, duration_ms: 200000, artists: [{ id: id('ax'), name: 'Xavier' }, { id: id('ag'), name: 'Guest' }] },
  ];
  return {
    id: id('alb'),
    name: 'New Record',
    album_type: 'album',
    release_date: '2024-01-01',
    release_date_precision: 'year',
    artists: [{ id: id('ax'), name: 'Xavier' }],
    images: [
      { url: 'https://i.scdn.co/image/640', width: 640, height: 640 },
      { url: 'https://i.scdn.co/image/300', width: 300, height: 300 },
    ],
    external_ids: { upc: '0123456789012' },
    total_tracks: items.length,
    tracks: { items, next: null },
    ...overrides,
  };
}

/** A Spotify client answering from fixtures, recording each path asked for. */
function fakeSpotify(a: SpotifyAlbum, isrcs: Record<string, string> = {}) {
  const asked: string[] = [];
  const client = {
    async get<T>(path: string): Promise<T> {
      asked.push(path);
      if (path === `/albums/${a.id}`) return a as T;
      const track = /^\/tracks\/(\w+)$/.exec(path);
      if (track) return { album: { id: a.id }, external_ids: isrcs[track[1]!] ? { isrc: isrcs[track[1]!] } : {} } as T;
      throw new Error(`unexpected ${path}`);
    },
    post: async () => undefined,
    put: async () => undefined,
  } as unknown as SpotifyClient;
  return { client, asked };
}

const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('parseSpotifyInput', () => {
  it('reads album and track links in every common form', () => {
    expect(parseSpotifyInput(`https://open.spotify.com/album/${id('a')}?si=abc`)).toEqual({ kind: 'album', id: id('a') });
    expect(parseSpotifyInput(`https://open.spotify.com/intl-fr/track/${id('t')}`)).toEqual({ kind: 'track', id: id('t') });
    expect(parseSpotifyInput(`spotify:album:${id('a')}`)).toEqual({ kind: 'album', id: id('a') });
  });

  it('refuses anything else', () => {
    expect(parseSpotifyInput(`https://open.spotify.com/playlist/${id('p')}`)).toBeNull();
    expect(parseSpotifyInput(`https://evil.example/album/${id('a')}`)).toBeNull();
    expect(parseSpotifyInput('https://open.spotify.com/album/short')).toBeNull();
  });
});

describe('planFromSpotify', () => {
  it('keeps the date only as precise as Spotify knows it', () => {
    expect(spotifyDate(album())).toEqual({ date: '2024', precision: 'year' });
    expect(spotifyDate(album({ release_date: '2019-06-14', release_date_precision: 'day' }))).toEqual({ date: '2019-06-14', precision: 'day' });
  });

  it('credits album artists as primary and anyone else as featured', () => {
    const plan = planFromSpotify(album());
    const duet = plan.credits.filter((c) => c.entity_key === `spotify:track:${id('t2')}`);
    expect(duet.map((c) => [c.role, c.join_phrase])).toEqual([
      ['primary', ' feat. '],
      ['featured', ''],
    ]);
  });

  it('leads a compilation track with its own artist', () => {
    const various = album({
      album_type: 'compilation',
      artists: [{ id: id('va'), name: 'Various Artists' }],
    });
    const plan = planFromSpotify(various);
    expect(plan.releaseGroup.type).toBe('compilation');
    const opening = plan.credits.filter((c) => c.entity_key === `spotify:track:${id('t1')}`);
    expect(opening.map((c) => [c.role, plan.artists.find((a) => a.key === c.artist_key)!.name])).toEqual([['primary', 'Xavier']]);
  });
});

describe('importFromSpotify', () => {
  it('builds the album from Spotify when MusicBrainz has no match, keeping the ids', async () => {
    const { client } = fakeSpotify(album(), { [id('t1')]: 'GBAYE0000001' });
    const result = await importFromSpotify({ kind: 'album', id: id('alb') }, client);
    expect(result.via).toBe('spotify');

    expect(db.prepare(`SELECT title, spotify_id, type, first_release_date, date_precision, source FROM release_group WHERE id = ?`).get(result.releaseGroupId)).toEqual({
      title: 'New Record',
      spotify_id: id('alb'),
      type: 'album',
      first_release_date: '2024',
      date_precision: 'year',
      source: 'spotify',
    });
    expect(db.prepare(`SELECT spotify_id, isrc FROM recording WHERE title = 'Opening'`).get()).toEqual({ spotify_id: id('t1'), isrc: 'GBAYE0000001' });
    // The existing Xavier, not a second one, and he takes the Spotify id.
    expect(db.prepare(`SELECT id, spotify_id FROM artist WHERE name = 'Xavier'`).all()).toEqual([{ id: 'art-x', spotify_id: id('ax') }]);
    // Under a version of their own, which the release's art_key names.
    const artKey = (db.prepare(`SELECT art_key FROM release WHERE id = ?`).get(result.releaseId) as { art_key: string }).art_key;
    expect(artKey).toMatch(new RegExp(`^art/release/${result.releaseId}/[0-9a-z]+$`));
    expect([...stored.keys()].sort()).toEqual([250, 500, 1200].map((s) => `${artKey}/${s}.jpg`).sort());
  });

  it('adds nothing on a second import of the same album', async () => {
    const { client } = fakeSpotify(album());
    await importFromSpotify({ kind: 'album', id: id('alb') }, client);
    const before = ['release_group', 'release', 'recording', 'track', 'artist', 'artist_credit'].map(count);
    await importFromSpotify({ kind: 'album', id: id('alb') }, client);
    expect(['release_group', 'release', 'recording', 'track', 'artist', 'artist_credit'].map(count)).toEqual(before);
  });

  it('adds an edition to the album already here with that title and artist', async () => {
    const { client } = fakeSpotify(album({ name: 'Album A (Deluxe Edition)' }));
    const groups = count('release_group');
    const result = await importFromSpotify({ kind: 'album', id: id('alb') }, client);
    expect(result.releaseGroupId).toBe('rg-a');
    expect(count('release_group')).toBe(groups);
    expect(db.prepare(`SELECT count(*) AS n FROM release WHERE release_group_id = 'rg-a'`).get()).toEqual({ n: 3 });
  });

  it('reuses a recording already here with the same ISRC', async () => {
    db.exec(`UPDATE recording SET isrc = 'GBAYE0000099' WHERE id = 'a1'`);
    const { client } = fakeSpotify(album(), { [id('t1')]: 'GBAYE0000099' });
    const result = await importFromSpotify({ kind: 'album', id: id('alb') }, client);
    const first = db.prepare(`SELECT recording_id FROM track WHERE release_id = ? AND position = 1`).get(result.releaseId);
    expect(first).toEqual({ recording_id: 'a1' });
  });

  it('follows a track link to its album', async () => {
    const { client, asked } = fakeSpotify(album());
    await importFromSpotify({ kind: 'track', id: id('t2') }, client);
    expect(asked[0]).toBe(`/tracks/${id('t2')}`);
    expect(asked[1]).toBe(`/albums/${id('alb')}`);
  });

  it('imports from MusicBrainz when the barcode finds it there, then fills in the Spotify ids', async () => {
    barcodeHits.value = [{ id: 'mb-release', score: 100, title: 'New Record' }];
    mbPlan.value = {
      ...planFromSpotify(album()),
      source: 'musicbrainz',
      artists: [{ key: 'mbx', mbid: '11111111-1111-4111-8111-111111111111', name: 'Xavier', sort_name: 'Xavier', disambiguation: null }],
      recordings: planFromSpotify(album()).recordings.map((r, i) => ({ ...r, key: `mbr${i}`, mbid: `22222222-2222-4222-8222-22222222222${i}`, spotify_id: null, isrc: null })),
      tracks: [1, 2].map((position, i) => ({ recording_key: `mbr${i}`, disc: 1, position, title_on_release: null })),
      credits: [
        { entity: 'release_group', entity_key: 'release_group', artist_key: 'mbx', role: 'primary', position: 1, credited_as: null, join_phrase: '' },
      ],
      releaseGroup: { ...planFromSpotify(album()).releaseGroup, mbid: '33333333-3333-4333-8333-333333333333', spotify_id: null },
      release: { ...planFromSpotify(album()).release, mbid: '44444444-4444-4444-8444-444444444444', spotify_id: null },
    };
    const { client } = fakeSpotify(album());
    const result = await importFromSpotify({ kind: 'album', id: id('alb') }, client);
    expect(result.via).toBe('musicbrainz');
    expect(db.prepare(`SELECT source, spotify_id FROM release_group WHERE id = ?`).get(result.releaseGroupId)).toEqual({ source: 'musicbrainz', spotify_id: id('alb') });
    expect(db.prepare(`SELECT title, spotify_id FROM recording WHERE mbid LIKE '22222222%' ORDER BY title`).all()).toEqual([
      { title: 'Duet', spotify_id: id('t2') },
      { title: 'Opening', spotify_id: id('t1') },
    ]);
  });

  it('fills in an album first built from Spotify once MusicBrainz has it, never a second copy', async () => {
    const { client } = fakeSpotify(album());
    const first = await importFromSpotify({ kind: 'album', id: id('alb') }, client);
    const opening = (db.prepare(`SELECT id FROM recording WHERE spotify_id = ?`).get(id('t1')) as { id: string }).id;
    const before = ['release_group', 'release', 'recording', 'track'].map(count);

    // Later, MusicBrainz has it: Refresh re-reads the Spotify album and the barcode now hits.
    barcodeHits.value = [{ id: 'mb-release', score: 100, title: 'New Record' }];
    const spotifyPlan = planFromSpotify(album());
    mbPlan.value = {
      ...spotifyPlan,
      source: 'musicbrainz',
      recordings: spotifyPlan.recordings.map((r, i) => ({ ...r, key: `mbr${i}`, mbid: `22222222-2222-4222-8222-22222222222${i}`, spotify_id: null })),
      tracks: [1, 2].map((position, i) => ({ recording_key: `mbr${i}`, disc: 1, position, title_on_release: null })),
      credits: [],
      releaseGroup: { ...spotifyPlan.releaseGroup, key: 'mbrg', mbid: '33333333-3333-4333-8333-333333333333', spotify_id: null },
      release: { ...spotifyPlan.release, key: 'mbrel', mbid: '44444444-4444-4444-8444-444444444444', spotify_id: null },
    };
    const again = await importFromSpotify({ kind: 'album', id: id('alb') }, client);

    expect(again.via).toBe('musicbrainz');
    expect(again.releaseGroupId).toBe(first.releaseGroupId);
    expect(['release_group', 'release', 'recording', 'track'].map(count)).toEqual(before);
    expect(db.prepare(`SELECT mbid FROM release_group WHERE id = ?`).get(first.releaseGroupId)).toEqual({ mbid: '33333333-3333-4333-8333-333333333333' });
    expect(db.prepare(`SELECT mbid FROM release WHERE id = ?`).get(first.releaseId)).toEqual({ mbid: '44444444-4444-4444-8444-444444444444' });
    // The same track row (and so its ratings), now with its MusicBrainz id.
    expect(db.prepare(`SELECT id, mbid FROM recording WHERE spotify_id = ?`).get(id('t1'))).toEqual({ id: opening, mbid: '22222222-2222-4222-8222-222222222220' });
  });

  it('does not trust an ambiguous barcode', async () => {
    barcodeHits.value = [
      { id: 'one', score: 100, title: 'X' },
      { id: 'two', score: 100, title: 'X' },
    ];
    const { client } = fakeSpotify(album());
    expect((await importFromSpotify({ kind: 'album', id: id('alb') }, client)).via).toBe('spotify');
  });
});

describe('without the deluxe match', () => {
  it('creates a new album when the title differs', async () => {
    insert(db, 'artist', [{ id: 'art-other', name: 'Other', sort_name: 'Other', source: 'manual' }]);
    const { client } = fakeSpotify(album({ name: 'Something Else' }));
    const groups = count('release_group');
    await importFromSpotify({ kind: 'album', id: id('alb') }, client);
    expect(count('release_group')).toBe(groups + 1);
  });
});
