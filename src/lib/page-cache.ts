/**
 * Whole rendered pages, kept in Cloudflare's edge cache (free, uncapped,
 * per data centre) under a key that carries the site's state. A page is
 * worked out once per change to the library and served from the cache
 * until the next one, so a visit costs one small stamp query instead of
 * the page's every read against D1's daily cap.
 *
 * Nothing is ever stale by more than a moment: any rating, import, edit,
 * new picture, playlist change or new weighting moves the stamp, and with
 * it every key. Pages also expire after a quarter of an hour, which keeps
 * relative times ("5 minutes ago") and the daily picks honest.
 */

import { env } from 'cloudflare:workers';

/** Public pages that show the library. Tools, forms and APIs are never cached. */
export function isCacheablePage(pathname: string): boolean {
  if (['/', '/artists', '/diary', '/genres', '/insights', '/playlists'].includes(pathname)) return true;
  if (pathname.endsWith('/elsewhere')) return false; // fetched from other services, cached on its own
  return /^\/(artist|album|track|genre|year|playlist)\/[^/]+$/.test(pathname);
}

/** How long a cached page may be served, in seconds. */
export const PAGE_MAX_AGE = 15 * 60;

/**
 * A short string that moves whenever anything a public page shows does.
 * Tables only ever added to are stamped by their highest rowid (one seek,
 * not a count): ratings are append-only, so theirs alone covers every
 * user's ratings. Small tables that change in place are read whole.
 */
export async function siteStamp(): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT (SELECT max(rowid) FROM rating) AS ratings,
            (SELECT max(rowid) FROM play) AS plays,
            (SELECT max(rowid) FROM artist) AS artists,
            (SELECT max(rowid) FROM release_group) AS releaseGroups,
            (SELECT max(rowid) FROM release) AS releases,
            (SELECT max(rowid) FROM recording) AS recordings,
            (SELECT max(rowid) FROM artist_credit) AS credits,
            (SELECT max(rowid) FROM genre_tag) AS tags,
            (SELECT max(rowid) FROM artist_image) AS images,
            (SELECT count(*) FROM artist_image WHERE hidden = 1) AS hidden,
            (SELECT count(*) FROM release WHERE art_key IS NOT NULL) AS covers,
            (SELECT max(edited_at) FROM field_override) AS edits,
            (SELECT max(updated_at) || ':' || count(*) FROM definition) AS playlists,
            (SELECT count(*) FROM definition_pin) AS pins,
            (SELECT count(*) FROM definition_exclude) AS excludes,
            (SELECT max(rowid) FROM definition_run) AS runs,
            (SELECT max(rowid) || ':' || count(*) FROM holding) AS holdings,
            (SELECT group_concat(id) FROM weights WHERE active = 1) AS weights,
            -- Renames and moves in the genre tree; it is small.
            (SELECT group_concat(id || '=' || name || '<' || coalesce(parent_id, ''), '|') FROM genre) AS genres,
            -- Further parents (0013) move genre pages as much as a primary one.
            (SELECT group_concat(genre_id || '<' || parent_id, '|') FROM genre_extra_parent) AS alsoUnder`,
  ).first<Record<string, string | number | null>>();
  return fingerprint(Object.values(row ?? {}).join('\u0000'));
}

/** A short, stable digest of a string (FNV-1a, 32-bit), for keys. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// One stamp serves a burst of requests: a page and its partials, or a crawler.
const MEMO_MS = 15_000;
let memo: { value: string; at: number } | null = null;

export async function currentStamp(now = Date.now()): Promise<string> {
  if (memo && now - memo.at < MEMO_MS) return memo.value;
  const value = await siteStamp();
  memo = { value, at: now };
  return value;
}

/** Forget the remembered stamp: after a write in this isolate, so its own pages are fresh at once. */
export function forgetStamp(): void {
  memo = null;
}

declare const __BUILD_ID__: string | undefined;
/** This deploy (set at build, see astro.config.mjs); absent in tests. */
const BUILD = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'test';

/** The cache key for a page as one viewer, in one theme, at one state of the site, from one deploy. */
export function pageKey(url: URL, stamp: string, viewer: string | null, theme: string | undefined): Request {
  const key = new URL(url.pathname + url.search, url.origin);
  key.searchParams.set('__site', stamp);
  key.searchParams.set('__build', BUILD);
  key.searchParams.set('__viewer', viewer ?? 'anyone');
  key.searchParams.set('__theme', theme ?? 'default');
  return new Request(key.toString(), { method: 'GET' });
}

/** Whether a rendered response may be kept: a whole page, for anyone, that sets nothing. */
export function isKeepable(response: Response): boolean {
  return (
    response.status === 200 &&
    (response.headers.get('Content-Type') ?? '').startsWith('text/html') &&
    !response.headers.has('Set-Cookie')
  );
}
