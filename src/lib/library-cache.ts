/**
 * Caching for whole-library computations (every track's facts, artists'
 * likeness, rankings). The key carries a stamp of the library's state
 * (the latest rating and edit, how far each big table has grown, covers
 * and pictures), so any change anywhere makes a fresh key: nothing is ever
 * stale, and nothing needs clearing by hand.
 */

import { env } from 'cloudflare:workers';
import { CHANGE_VERSIONS } from './page-cache';
import { perRequest } from './request-scope';

/**
 * A short string that changes whenever the library or a user's ratings or
 * plays do. It runs before every cached read, so it must cost next to
 * nothing in rows read (D1 bills and caps them): the big tables are only
 * ever added to, so their highest rowid moves with them and costs one seek,
 * where counting them read every row (58,000 credits) each time. Ratings
 * are append-only too, so the highest rowid stands for every user's. Covers
 * and pictures change in place; triggers count their changes
 * (CHANGE_VERSIONS), where counting them read about 4,000 rows a stamp.
 *
 * Remembered for a few seconds per user, as the page stamp is: a page that
 * reads several cached values works the stamp out once. A write in this
 * isolate forgets it (forgetLibraryStamp, from the middleware).
 */
const MEMO_MS = 15_000;
// Settled stamps only, across requests; one being read is shared within its
// request (perRequest), so a page's sections started together read it once.
const memo = new Map<string, { value: string; at: number }>();

export function forgetLibraryStamp(): void {
  memo.clear();
}

export async function libraryStamp(userId: string | null, now = Date.now()): Promise<string> {
  const key = userId ?? '';
  const remembered = memo.get(key);
  if (remembered && now - remembered.at < MEMO_MS) return remembered.value;
  const value = await perRequest(`library-stamp:${key}`, () => readLibraryStamp(userId));
  memo.set(key, { value, at: now });
  return value;
}

async function readLibraryStamp(userId: string | null): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT (SELECT max(rated_at) FROM rating WHERE user_id = ?1) AS rated,
            -- Only for a user's values: those for no one (artists' likeness,
            -- the library's shape) do not move with ratings.
            (SELECT max(rowid) FROM rating WHERE ?1 IS NOT NULL) AS ratings,
            (SELECT max(rowid) FROM play) AS plays,
            (SELECT max(rowid) FROM artist_credit) AS credits,
            (SELECT max(rowid) FROM genre_tag) AS genres,
            (SELECT max(rowid) FROM artist) AS artists,
            (SELECT max(rowid) FROM release_group) AS releases,
            -- Editions and tracks added to an album already here; merges,
            -- which move tracks and ratings in place but always leave a redirect.
            (SELECT max(rowid) FROM release) AS editions,
            (SELECT max(rowid) FROM track) AS tracks,
            (SELECT max(rowid) FROM entity_redirect) AS merges,
            -- Hand edits: a rename or a picture order changes no count.
            (SELECT max(edited_at) FROM field_override) AS edits,
            -- Pictures found later (a cover, an artist photo), and the genre tree.
            ${CHANGE_VERSIONS} AS changed`,
  )
    .bind(userId)
    .first<Record<string, string | number | null>>();
  return Object.values(row ?? {}).join(':');
}

declare const __BUILD_ID__: string | undefined;
/**
 * This deploy (set at build, see astro.config.mjs). In every key, so a value
 * worked out by older code, in an older shape, is never read by newer code.
 */
const BUILD = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'test';

/**
 * Development only: work everything out as if the cache were empty, to
 * measure a page as it is after a rating (the dev meter sets it for a
 * request with ?__cold).
 */
export const devCold = { on: false };

const DAY = 24 * 60 * 60;

/** What is kept under key, or null (nothing kept, no cache, or measuring cold). */
async function kept<T>(key: string): Promise<T | null> {
  if (devCold.on) return null;
  try {
    return await env.CACHE.get<T>(key, 'json');
  } catch {
    return null; // No cache: work it out.
  }
}

async function keep(key: string, value: unknown, days: number): Promise<void> {
  try {
    await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: days * DAY });
  } catch {
    /* Uncached is only slower. */
  }
}

/** The value under key: kept, or worked out and kept; once per request however often asked. */
function keptOrWorkedOut<T>(key: string, days: number, work: () => Promise<T>): Promise<T> {
  return perRequest(key, async () => {
    const hit = await kept<{ value: T }>(key);
    if (hit) return hit.value;
    const value = await work();
    await keep(key, { value }, days);
    return value;
  });
}

const libraryKey = async (name: string, userId: string | null) => `lib:${BUILD}:${name}:${userId ?? '-'}:${await libraryStamp(userId)}`;

/**
 * The value under name for this library state, worked out and kept when
 * missing. Within one request it is looked up once, however many sections
 * ask for it at the same time (a user's album scores, say).
 */
export async function byLibrary<T>(name: string, userId: string | null, work: () => Promise<T>): Promise<T> {
  return keptOrWorkedOut(await libraryKey(name, userId), 7, work);
}

/**
 * The value under name for today (UTC), worked out at most once a day. For
 * readings that one import barely moves and that are dear to work out
 * (which artists are close to which: 90,000 rows for a big artist), where
 * byLibrary would work them out again after every album imported.
 */
export function byDay<T>(name: string, work: () => Promise<T>, now = new Date()): Promise<T> {
  return keptOrWorkedOut(`day:${BUILD}:${name}:${now.toISOString().slice(0, 10)}`, 2, work);
}

/**
 * A map by id, kept for this library state and grown as ids are asked for:
 * only ids it does not hold yet are worked out (`work` gets those and
 * answers for them), and the grown map is kept. For per-item facts that do
 * not change when something is rated, asked for over a set that does (every
 * rated track): a new rating costs one item, not all of them again. An id
 * `work` gives nothing for is kept as null, so it is not asked again.
 */
export async function byLibraryMap<V>(
  name: string,
  userId: string | null,
  ids: string[],
  work: (missing: string[]) => Promise<Record<string, V>>,
): Promise<Record<string, V | null>> {
  const key = await libraryKey(name, userId);
  const held = (await kept<Record<string, V | null>>(key)) ?? {};
  const missing = ids.filter((id) => !(id in held));
  if (missing.length === 0) return held;
  const found = await work(missing);
  const grown = { ...held };
  for (const id of missing) grown[id] = found[id] ?? null;
  await keep(key, grown, 7);
  return grown;
}
