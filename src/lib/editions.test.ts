import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { migratedDb, seedLibrary } from '../test/db';
import { batchCredit, recordingCredits } from './credits';
import { createEdition, newEdition } from './editions';
import { fillFromSpotify } from './spotify/fill';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

const edition = (o: Record<string, string>) =>
  newEdition.parse({ title: 'Album A', date: '', label: '', format: '', note: '', copy_from: '', tracklist: '', ...o });

describe('createEdition', () => {
  it('copies the standard edition by default', async () => {
    const made = await createEdition('rg-a', edition({ date: '2023-06-30', note: 'Pulled from streaming' }));
    expect(made).toMatchObject({ matched: 3, created: 0 });
    expect(db.prepare(`SELECT note, date FROM release WHERE id = ?`).get(made.releaseId)).toEqual({ note: 'Pulled from streaming', date: '2023-06-30' });
  });

  it('matches a pasted list to the album’s songs, keeps its styling, and adds what is new', async () => {
    const made = await createEdition('rg-a', edition({ tracklist: '1. SONG A1\n2. Brand New Song (feat. Guest)\n3. song a3' }));
    expect(made).toMatchObject({ matched: 2, created: 1 });
    const rows = db
      .prepare(`SELECT t.recording_id, t.title_on_release FROM track t WHERE t.release_id = ? ORDER BY t.position`)
      .all(made.releaseId) as { recording_id: string; title_on_release: string | null }[];
    expect(rows[0]).toEqual({ recording_id: 'a1', title_on_release: 'SONG A1' });
    expect(rows[2]).toEqual({ recording_id: 'a3', title_on_release: 'song a3' });
    expect((await recordingCredits(rows[1]!.recording_id)).map((c) => `${c.role}:${c.name}`)).toEqual(['primary:Xavier', 'featured:Guest']);
  });
});

describe('batchCredit', () => {
  it('adds to ticked tracks on the album only, and removes again', async () => {
    expect(await batchCredit('u-owner', 'rg-a', { recordingIds: ['a1', 'a2', 'b1'], role: 'producer', name: 'Pat Producer', mode: 'add' })).toBe(2);
    expect(db.prepare(`SELECT count(*) AS n FROM artist_credit WHERE role = 'producer' AND artist_id = 'art-p'`).get()).toEqual({ n: 3 });
    expect(await batchCredit('u-owner', 'rg-a', { recordingIds: ['a1', 'a2'], role: 'producer', name: 'Pat Producer', mode: 'remove' })).toBe(2);
  });
});

describe('fillFromSpotify', () => {
  it('fills a missing date, lengths and ISRCs, and nothing already set', async () => {
    db.prepare(`UPDATE release_group SET spotify_id = 'sp-album', first_release_date = NULL, date_precision = 'unknown' WHERE id = 'rg-b'`).run();
    db.prepare(`UPDATE recording SET length_ms = 1000 WHERE id = 'b1'`).run();
    const spotify = {
      get: async <T,>(path: string): Promise<T> =>
        (path.startsWith('/albums/')
          ? {
              id: 'sp-album',
              name: 'Album B',
              album_type: 'album',
              release_date: '2020-05-01',
              release_date_precision: 'day',
              artists: [],
              images: [],
              total_tracks: 2,
              tracks: {
                items: [
                  { id: 't1', name: 'Song B1', disc_number: 1, track_number: 1, duration_ms: 2000, artists: [] },
                  { id: 't2', name: 'Song B2', disc_number: 1, track_number: 2, duration_ms: 3000, artists: [] },
                ],
                next: null,
              },
            }
          : { external_ids: { isrc: `usabc240000${path.slice(-1)}` } }) as T,
    };
    expect(await fillFromSpotify(spotify, 'rg-b')).toEqual({ date: true, lengths: 1, isrcs: 2 });
    expect(db.prepare(`SELECT first_release_date FROM release_group WHERE id = 'rg-b'`).get()).toEqual({ first_release_date: '2020-05-01' });
    expect(db.prepare(`SELECT id, length_ms, isrc FROM recording WHERE id IN ('b1', 'b2') ORDER BY id`).all()).toEqual([
      { id: 'b1', length_ms: 1000, isrc: 'USABC2400001' },
      { id: 'b2', length_ms: 3000, isrc: 'USABC2400002' },
    ]);
  });
});

describe('refreshArtist', () => {
  it('queues a lookup for each of their albums that has a source', async () => {
    const { refreshArtist } = await import('./refresh');
    db.prepare(`UPDATE release SET mbid = 'mb-r-a' WHERE id = 'r-a'`).run();
    db.prepare(`UPDATE release_group SET spotify_id = 'sp-b' WHERE id = 'rg-b'`).run();
    const queued = await refreshArtist('art-x');
    expect(queued.map((a) => [a.title, a.jobs.length]).sort()).toEqual([
      ['Album A', 1],
      ['Album B', 1],
    ]);
    expect(db.prepare(`SELECT count(*) AS n FROM job WHERE kind = 'import_release'`).get()).toEqual({ n: 2 });
  });
});

describe('pausing the queue', () => {
  it('holds waiting jobs while paused, and lets one be removed', async () => {
    const { claimNext, enqueue, removeQueued, setQueuePaused } = await import('./jobs/queue');
    const a = await enqueue('backup', {});
    const b = await enqueue('backup', {});
    await setQueuePaused(true);
    expect(await claimNext()).toBeNull();
    expect(await removeQueued(b)).toBe(true);
    await setQueuePaused(false);
    expect((await claimNext())?.id).toBe(a);
    expect(await claimNext()).toBeNull();
  });
});
