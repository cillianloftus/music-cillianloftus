import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { migratedDb, seedLibrary } from '../test/db';
import { albumQueue, matchFiles, playableSongs, storeAudio, type FileToMatch } from './audio';

let db: DatabaseSync;
const stored = new Map<string, number>();

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
  stored.clear();
  // The private bucket, counting what it is sent.
  (env as unknown as { AUDIO_STORE: unknown }).AUDIO_STORE = {
    put: async (key: string, body: ReadableStream) => {
      let n = 0;
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) n += chunk.byteLength;
      stored.set(key, n);
    },
    delete: async (keys: string[]) => {
      for (const k of keys) stored.delete(k);
    },
  };
});

const file = (over: Partial<FileToMatch>): FileToMatch => ({
  path: 'Xavier/Album B/01.flac',
  checksum: null,
  format: 'flac',
  title: null,
  artist: 'Xavier',
  albumArtist: null,
  album: 'Album B',
  lengthMs: null,
  mbRecordingId: null,
  ...over,
});

describe('listens on your own player', () => {
  it('are logged as plays of the song, counted from thirty seconds', async () => {
    const { logLocalPlay } = await import('./audio');
    expect(await logLocalPlay('u-owner', 'b1', '2026-11-16T21:00:00.000Z', 185_000)).toBe(true);
    expect(await logLocalPlay('u-owner', 'b1', '2026-11-16T22:00:00.000Z', 12_000)).toBe(true);
    const plays = db.prepare(`SELECT recording_id, ms_played, counted, source, platform FROM play WHERE user_id = 'u-owner' AND platform = 'Your files' ORDER BY played_at`).all();
    expect(plays).toEqual([
      { recording_id: 'b1', ms_played: 185000, counted: 1, source: 'manual', platform: 'Your files' },
      { recording_id: 'b1', ms_played: 12000, counted: 0, source: 'manual', platform: 'Your files' },
    ]);
    // The same listen sent twice is one play.
    expect(await logLocalPlay('u-owner', 'b1', '2026-11-16T21:00:00.000Z', 185_000)).toBe(false);
  });
});

describe('your files, matched to songs', () => {
  it('by the tagged artist and title, guests and case aside, and not a song far longer', async () => {
    const [b1, unknown] = await matchFiles([file({ title: 'song b1 (feat. Someone)' }), file({ path: 'x.flac', title: 'Not In The Library' })]);
    expect(b1).toMatchObject({ recordingId: 'b1', title: 'Song B1', uploaded: false });
    expect(unknown?.recordingId).toBeNull();
    db.prepare(`UPDATE recording SET length_ms = 200000 WHERE id = 'b1'`).run();
    const [far] = await matchFiles([file({ title: 'Song B1', lengthMs: 400000 })]);
    expect(far?.recordingId).toBeNull();
  });

  it('are uploaded once, then known by their checksum, and play in album order', async () => {
    const sum = 'a'.repeat(64);
    const bytes = new TextEncoder().encode('not really a flac');
    const id = await storeAudio({ recordingId: 'b2', path: 'Xavier/Album B/02.flac', format: 'flac', checksum: sum, size: bytes.byteLength, body: new Response(bytes).body! });
    expect([...stored.values()]).toEqual([bytes.byteLength]);
    expect(db.prepare(`SELECT audio_key, audio_bytes FROM file WHERE id = ?`).get(id)).toEqual({ audio_key: `audio/${id}.flac`, audio_bytes: bytes.byteLength });
    // The same file again, from anywhere: already there.
    const [again] = await matchFiles([file({ path: 'elsewhere/02.flac', checksum: sum, title: 'Whatever' })]);
    expect(again).toMatchObject({ recordingId: 'b2', uploaded: true });
    expect([...(await playableSongs(['b1', 'b2']))]).toEqual(['b2']);
    expect((await albumQueue('rg-b')).map((t) => [t.recordingId, t.fileId])).toEqual([['b2', id]]);
    // Removed: the stored copy goes, the file stays catalogued.
    const { removeAudio } = await import('./audio');
    expect(await removeAudio([id])).toBe(1);
    expect(stored.size).toBe(0);
    expect(db.prepare('SELECT audio_key, path FROM file WHERE id = ?').get(id)).toEqual({ audio_key: null, path: 'Xavier/Album B/02.flac' });
    expect(await albumQueue('rg-b')).toEqual([]);
  });
});
