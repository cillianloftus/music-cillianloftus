import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { migratedDb } from '../test/db';
import { dueArtists } from './artists';

beforeEach(() => {
  const db = migratedDb();
  (env as { DB: D1Database }).DB = d1(db);
  const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const add = db.prepare(`INSERT INTO artist (id, name, sort_name, mbid, source, enriched_at) VALUES (?, ?, ?, ?, 'musicbrainz', ?)`);
  add.run('fresh', 'Fresh', 'Fresh', 'mb-fresh', days(3));
  add.run('old', 'Old', 'Old', 'mb-old', days(200));
  add.run('older', 'Older', 'Older', 'mb-older', days(400));
  add.run('never', 'Never', 'Never', 'mb-never', null);
  add.run('no-mbid', 'Local', 'Local', null, null);
});

describe('artists due a look', () => {
  it('takes the never-looked-at first, then the longest ago, skipping the recent and the unlinked', async () => {
    expect(await dueArtists(10)).toEqual(['never', 'older', 'old']);
  });

  it('stops at the number asked for', async () => {
    expect(await dueArtists(2)).toEqual(['never', 'older']);
  });
});
