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
  });
});
