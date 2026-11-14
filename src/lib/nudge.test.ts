import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';
import { inLibrary, nudgeMessage, secondsUntilMorning } from './nudge';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
  db.exec(`UPDATE recording SET spotify_id = 'spA1' WHERE id = 'a1'`);
  insert(db, 'recording', [{ id: 'n1', title: 'New one', source: 'musicbrainz', isrc: 'GBAAA2600001' }]);
});

describe('rate what is playing', () => {
  it('finds the song by its Spotify id, and knows it is rated', async () => {
    expect(await inLibrary({ spotifyId: 'spA1', isrc: null }, 'u-owner')).toEqual({ id: 'a1', rated: true });
    // Someone else's rating is not this listener's.
    expect(await inLibrary({ spotifyId: 'spA1', isrc: null }, 'u-friend')).toEqual({ id: 'a1', rated: false });
  });

  it('falls back on the ISRC when the Spotify id is not known here, and remembers the id', async () => {
    expect(await inLibrary({ spotifyId: 'spN1', isrc: 'GBAAA2600001' }, 'u-owner')).toEqual({ id: 'n1', rated: false });
    expect(db.prepare(`SELECT spotify_id FROM recording WHERE id = 'n1'`).get()).toEqual({ spotify_id: 'spN1' });
    expect(await inLibrary({ spotifyId: 'nowhere', isrc: null }, 'u-owner')).toBeNull();
  });

  it('falls back on the title and artist: Spotify has several ids for one song', async () => {
    // a1 already has a Spotify id; this is another of the same song's.
    const playing = { spotifyId: 'spA1-reissue', isrc: null, title: 'Song A1 - Remastered 2011', artists: ['Xavier'], album: 'Album A' };
    expect(await inLibrary(playing, 'u-owner')).toEqual({ id: 'a1', rated: true });
    // Its own id is left as it was.
    expect(db.prepare(`SELECT spotify_id FROM recording WHERE id = 'a1'`).get()).toEqual({ spotify_id: 'spA1' });
    // Not by someone else of the same title.
    expect(await inLibrary({ ...playing, artists: ['Someone Else'] }, 'u-owner')).toBeNull();
  });

  it('says what is playing and opens its rating page', () => {
    const message = nudgeMessage({ spotifyId: 'x', isrc: null, title: 'Ivy', artists: ['Frank Ocean'], album: 'Blonde', art: 'https://i.scdn.co/a' }, 'n1');
    expect(message).toMatchObject({ title: 'Ivy', body: 'Frank Ocean · not rated yet', url: '/edit/rate/recording/n1', tag: 'rate-now' });
  });

  it('pauses "not today" until five in the morning, Irish time', () => {
    // 22:30 in Dublin in November (UTC+0): six and a half hours.
    expect(secondsUntilMorning(new Date('2026-11-11T22:30:00Z'))).toBe(6.5 * 3600);
    // 01:00 Irish summer time (UTC+1) is midnight UTC: four hours.
    expect(secondsUntilMorning(new Date('2026-07-01T00:00:00Z'))).toBe(4 * 3600);
    // Just after five: nearly a whole day.
    expect(secondsUntilMorning(new Date('2026-11-11T05:10:00Z'))).toBe(24 * 3600 - 10 * 60);
  });
});
