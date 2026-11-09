/**
 * Caching for whole-library computations (every track's facts, artists'
 * likeness, rankings). The key carries a stamp of the library's state
 * (the latest rating and edit, how far each big table has grown, covers
 * and pictures), so any change anywhere makes a fresh key: nothing is ever
 * stale, and nothing needs clearing by hand.
 */

import { env } from 'cloudflare:workers';
import { CHANGE_VERSIONS } from './page-cache';

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
const memo = new Map<string, { value: string; at: number }>();

export function forgetLibraryStamp(): void {
  memo.clear();
}

export async function libraryStamp(userId: string | null, now = Date.now()): Promise<string> {
  const remembered = memo.get(userId ?? '');
  if (remembered && now - remembered.at < MEMO_MS) return remembered.value;
  const value = await readLibraryStamp(userId);
  memo.set(userId ?? '', { value, at: now });
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

/** The value under name for this library state, worked out and kept when missing. */
export async function byLibrary<T>(name: string, userId: string | null, work: () => Promise<T>): Promise<T> {
  const key = `lib:${BUILD}:${name}:${userId ?? '-'}:${await libraryStamp(userId)}`;
  try {
    const hit = await env.CACHE.get<{ value: T }>(key, 'json');
    if (hit) return hit.value;
  } catch {
    /* No cache: work it out. */
  }
  const value = await work();
  try {
    await env.CACHE.put(key, JSON.stringify({ value }), { expirationTtl: 7 * 24 * 60 * 60 });
  } catch {
    /* Uncached is only slower. */
  }
  return value;
}
