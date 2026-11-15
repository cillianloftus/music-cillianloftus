import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { d1 } from '../../test/d1';
import { migratedDb, seedLibrary } from '../../test/db';
import { claimNext } from '../jobs/queue';
import { queueDiscography } from './discography';

// MusicBrainz answers with these release groups for any artist.
vi.mock('../musicbrainz/client', async (original) => ({
  ...(await original<typeof import('../musicbrainz/client')>()),
  browseArtistReleaseGroups: async () => [
    { id: 'rg-new-2', title: 'Second Album', 'primary-type': 'Album', 'secondary-types': [], 'first-release-date': '2012-05-01' },
    { id: 'rg-new-1', title: 'First Album', 'primary-type': 'Album', 'secondary-types': [], 'first-release-date': '2010-01-01' },
    { id: 'rg-held', title: 'Already Here', 'primary-type': 'Album', 'secondary-types': [], 'first-release-date': '2011-01-01' },
    { id: 'rg-live', title: 'Live Somewhere', 'primary-type': 'Album', 'secondary-types': ['Live'], 'first-release-date': '2013-01-01' },
    { id: 'rg-future', title: 'Not Out Yet', 'primary-type': 'Album', 'secondary-types': [], 'first-release-date': '2999-01-01' },
  ],
}));

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  db.prepare(`UPDATE release_group SET mbid = 'rg-held' WHERE id = 'rg-a'`).run();
  (env as { DB: D1Database }).DB = d1(db);
});

describe('queueing a discography', () => {
  it('queues what is wanted and new, oldest first, each named, in one batch', async () => {
    const result = await queueDiscography('artist-mbid', new Set(['album']));
    expect(result).toMatchObject({ found: 3, skipped: 1 });
    expect(result.queued.map((q) => q.title)).toEqual(['First Album', 'Second Album']);

    // The queue hands them out in that order, though they were inserted in the same instant.
    const first = await claimNext();
    const second = await claimNext();
    expect([first, second].map((j) => JSON.parse(j!.payload_json))).toEqual([
      { source: 'musicbrainz', target: { entity: 'release-group', mbid: 'rg-new-1' }, label: 'First Album' },
      { source: 'musicbrainz', target: { entity: 'release-group', mbid: 'rg-new-2' }, label: 'Second Album' },
    ]);
  });
});

describe('putting a discography first', () => {
  it('jumps a bulk queue, and pulls their albums already waiting to the front without queueing them twice', async () => {
    const { enqueueMany } = await import('../jobs/queue');
    // A long bulk queue, with one of this artist's albums deep in it.
    const [other] = await enqueueMany('import_release', [{ label: 'Someone else' }] as never);
    await enqueueMany('import_release', [{ source: 'musicbrainz', target: { entity: 'release-group', mbid: 'rg-new-1' }, label: 'First Album' }] as never);

    const result = await queueDiscography('artist-mbid', new Set(['album']), 1);
    expect(result.promoted).toBe(1);
    expect(result.queued.map((q) => q.title)).toEqual(['First Album', 'Second Album']);
    expect(db.prepare(`SELECT count(*) AS n FROM job WHERE status = 'queued'`).get()).toEqual({ n: 3 });

    const order = [await claimNext(), await claimNext(), await claimNext()].map((j) => JSON.parse(j!.payload_json).label);
    expect(order).toEqual(['First Album', 'Second Album', 'Someone else']);
    expect(other).toBeTruthy();
  });

  it('queued again without it, adds nothing already waiting', async () => {
    await queueDiscography('artist-mbid', new Set(['album']));
    const again = await queueDiscography('artist-mbid', new Set(['album']));
    expect(again.queued).toEqual([]);
    expect(db.prepare(`SELECT count(*) AS n FROM job WHERE status = 'queued'`).get()).toEqual({ n: 2 });
  });
});
