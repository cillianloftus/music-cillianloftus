import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';
import { currentStamp, fingerprint, forgetStamp, isCacheablePage, isKeepable, pageKey, siteStamp } from './page-cache';

describe('isCacheablePage', () => {
  it('keeps the public pages that show the library', () => {
    for (const path of ['/', '/artists', '/diary', '/insights', '/artist/abc', '/album/abc', '/track/abc', '/genre/abc', '/year/2026', '/playlist/abc']) {
      expect(isCacheablePage(path), path).toBe(true);
    }
  });

  it('never keeps tools, APIs, files or partials', () => {
    for (const path of ['/manage', '/queue', '/query', '/search', '/edit/rate/recording/x', '/api/write/rate', '/artist/abc/elsewhere', '/playlist/abc/cover.jpg', '/art/release/x/250.jpg']) {
      expect(isCacheablePage(path), path).toBe(false);
    }
  });
});

describe('pageKey', () => {
  const url = new URL('https://music.example/artists?sort=name');
  it('differs by state, viewer and theme, and keeps the page’s own query', () => {
    const base = pageKey(url, 's1', null, undefined).url;
    expect(base).toContain('sort=name');
    expect(pageKey(url, 's2', null, undefined).url).not.toBe(base);
    expect(pageKey(url, 's1', 'u-owner', undefined).url).not.toBe(base);
    expect(pageKey(url, 's1', null, 'light').url).not.toBe(base);
    expect(pageKey(url, 's1', null, undefined).url).toBe(base);
  });
});

describe('isKeepable', () => {
  const html = { 'Content-Type': 'text/html; charset=utf-8' };
  it('keeps a whole page and nothing that sets a cookie or failed', () => {
    expect(isKeepable(new Response('<p>', { headers: html }))).toBe(true);
    expect(isKeepable(new Response('<p>', { status: 404, headers: html }))).toBe(false);
    expect(isKeepable(new Response('{}', { headers: { 'Content-Type': 'application/json' } }))).toBe(false);
    expect(isKeepable(new Response('<p>', { headers: { ...html, 'Set-Cookie': 'theme=light' } }))).toBe(false);
  });
});

describe('fingerprint', () => {
  it('is stable and short', () => {
    expect(fingerprint('abc')).toBe(fingerprint('abc'));
    expect(fingerprint('abc')).not.toBe(fingerprint('abd'));
    expect(fingerprint('x'.repeat(10_000)).length).toBeLessThan(8);
  });
});

describe('siteStamp', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = migratedDb();
    seedLibrary(db);
    (env as { DB: D1Database }).DB = d1(db);
    forgetStamp();
  });

  const changes: Array<[string, () => void]> = [
    ['anyone’s rating', () => insert(db, 'rating', [{ id: 'n', user_id: 'u-friend', entity_type: 'recording', entity_id: 'a1', depth: 'gut', gut_score: 3, rated_at: '2026-02-01T00:00:00.000Z' }])],
    ['a genre renamed', () => db.exec(`UPDATE genre SET name = 'Indie pop' WHERE id = 'g-indie'`)],
    ['a new picture', () => {
      insert(db, 'artist_image', [{ id: 'i1', artist_id: 'art-x', key: 'art/artist/art-x/1.jpg', source: 'manual', position: 0 }]);
    }],
    ['a cover found', () => db.exec(`UPDATE release SET art_key = 'art/release/r-a/c.jpg' WHERE id = 'r-a'`)],
  ];
  for (const [what, change] of changes) {
    it(`moves with ${what}`, async () => {
      const before = await siteStamp();
      change();
      expect(await siteStamp()).not.toBe(before);
    });
  }

  it('is remembered briefly, and forgotten after a write', async () => {
    const first = await currentStamp(1_000);
    insert(db, 'rating', [{ id: 'n2', user_id: 'u-owner', entity_type: 'recording', entity_id: 'a1', depth: 'gut', gut_score: 3, rated_at: '2026-02-01T00:00:00.000Z' }]);
    expect(await currentStamp(5_000)).toBe(first); // within the moment
    forgetStamp();
    expect(await currentStamp(6_000)).not.toBe(first);
  });
});
