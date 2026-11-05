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
