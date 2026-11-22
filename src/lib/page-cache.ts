/**
 * Whole rendered pages, kept in Cloudflare's edge cache (free, uncapped,
 * per data centre) under a key that carries the site's state. A page is
 * worked out once per change to the library and served from the cache
 * until the next one, so a visit costs one small stamp query instead of
 * the page's every read against D1's daily cap.
 *
 * Two stamps (22 Nov). What someone does on the site (a rating, an edit, a
 * merge, a playlist: any write, counted in writes_version) is in the key,
 * so their next page is never stale. Everything else that moves (imports,
 * the cron, listens synced, covers found) changes the full stamp, kept in
 * the cached page: a page whose full stamp has moved, or that is over a
 * quarter of an hour old (relative times, daily picks), is served at once
 * and rendered again behind it for the next visit. Before, the full stamp
 * was the key: with imports running every minute nearly every visit was
 * rendered from nothing (the home page in 6 s).
 */

import { env } from 'cloudflare:workers';

/** Public pages that show the library. Tools, forms and APIs are never cached. */
export function isCacheablePage(pathname: string): boolean {
  if (['/', '/albums', '/artists', '/diary', '/genres', '/insights', '/lists', '/playlists'].includes(pathname)) return true;
  if (pathname.endsWith('/elsewhere')) return false; // fetched from other services, cached on its own
  return /^\/(artist|album|track|genre|year|playlist|label|list)\/[^/]+$/.test(pathname) || /^\/artist\/[^/]+\/tracks$/.test(pathname);
}

/** How long the edge may keep a page, in seconds: a day, served stale and refreshed (FRESH_MS). */
export const PAGE_MAX_AGE = 24 * 60 * 60;
/** A kept page older than this is refreshed behind the visit it serves. */
export const FRESH_MS = 15 * 60 * 1000;
/** On a kept page: the full stamp it was rendered at, and when. */
export const STAMP_HEADER = 'x-page-stamp';
export const RENDERED_HEADER = 'x-page-rendered';

/**
 * What changes in place without growing a table: covers, artist pictures,
 * the genre tree (migration 0049), weights and track kinds, which move
 * scores (0051), and catalogue rows deleted or filled in place, which no
 * highest rowid shows (0052). Triggers bump a number in app_setting for
 * each, so reading them is a few lookups where counting them read about
 * 4,000 rows.
 */
export const CHANGE_VERSIONS = `(SELECT group_concat(key || '=' || value) FROM app_setting
   WHERE key IN ('covers_version', 'pictures_version', 'genres_version', 'scores_version', 'library_version'))`;

/**
 * A short string that moves whenever anything a public page shows does.
 * Tables only ever added to are stamped by their highest rowid (one seek,
 * not a count): ratings are append-only, so theirs alone covers every
 * user's ratings. What changes in place is stamped by CHANGE_VERSIONS;
 * small tables are read whole.
 */
export async function siteStamp(): Promise<string> {
  return (await siteStamps()).full;
}

export interface Stamps {
  /** Moves with what people do on the site: the cache key. */
  mine: string;
  /** Moves with anything a page shows: a kept page rendered at another is refreshed. */
  full: string;
}

export async function siteStamps(): Promise<Stamps> {
  const row = await env.DB.prepare(
    `SELECT (SELECT value FROM app_setting WHERE key = 'writes_version') AS writes,
            (SELECT max(rowid) FROM rating) AS ratings,
            (SELECT max(rowid) FROM play) AS plays,
            (SELECT max(rowid) FROM artist) AS artists,
            (SELECT max(rowid) FROM release_group) AS releaseGroups,
            (SELECT max(rowid) FROM release) AS releases,
            (SELECT max(rowid) FROM recording) AS recordings,
            (SELECT max(rowid) FROM artist_credit) AS credits,
            (SELECT max(rowid) FROM track) AS tracks,
            -- Merges move rows in place but always leave a redirect.
            (SELECT max(rowid) FROM entity_redirect) AS merges,
            (SELECT max(rowid) FROM genre_tag) AS tags,
            ${CHANGE_VERSIONS} AS changed,
            (SELECT max(edited_at) FROM field_override) AS edits,
            (SELECT max(updated_at) || ':' || count(*) FROM definition) AS playlists,
            (SELECT count(*) FROM definition_pin) AS pins,
            (SELECT count(*) FROM definition_exclude) AS excludes,
            (SELECT max(rowid) FROM definition_run) AS runs,
            (SELECT max(rowid) || ':' || count(*) FROM holding) AS holdings,
            (SELECT group_concat(id) FROM weights WHERE active = 1) AS weights`,
  ).first<Record<string, string | number | null>>();
  return {
    mine: fingerprint([row?.writes, row?.ratings, row?.weights].join('\u0000')),
    full: fingerprint(Object.values(row ?? {}).join('\u0000')),
  };
}

/**
 * Writes that change no page: the player's commands and listens, loudness
 * measured, notification and playing settings. Every other write by a
 * signed-in person moves writes_version (bumpWrites).
 */
const QUIET_WRITES = ['/api/write/player', '/api/write/audio/played', '/api/write/audio/loudness', '/api/write/push', '/api/write/play-prefer'];
export const movesPages = (pathname: string) => !QUIET_WRITES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

/** Someone changed something: every cached page's key moves, so their next page is fresh. */
export async function bumpWrites(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_setting (key, value) VALUES ('writes_version', '1')
     ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
  ).run();
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
let memo: { value: Stamps; at: number } | null = null;

export async function currentStamps(now = Date.now()): Promise<Stamps> {
  if (memo && now - memo.at < MEMO_MS) return memo.value;
  const value = await siteStamps();
  memo = { value, at: now };
  return value;
}

export async function currentStamp(now = Date.now()): Promise<string> {
  return (await currentStamps(now)).full;
}

/** Whether a kept page should be rendered again behind the visit it serves. */
export function isStale(kept: Response, full: string, now = Date.now()): boolean {
  const rendered = Number(kept.headers.get(RENDERED_HEADER) ?? 0);
  return kept.headers.get(STAMP_HEADER) !== full || !rendered || now - rendered > FRESH_MS;
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
