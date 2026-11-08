/**
 * Caching for whole-library computations (every track's facts, artists'
 * likeness, rankings). The key carries a stamp of the library's state
 * (the latest rating and edit, how far each big table has grown, covers
 * and pictures), so any change anywhere makes a fresh key: nothing is ever
 * stale, and nothing needs clearing by hand.
 */

import { env } from 'cloudflare:workers';

/**
 * A short string that changes whenever the library or a user's ratings or
 * plays do. It runs before every cached page, so it must cost next to
 * nothing in rows read (D1 bills and caps them): the big tables are only
 * ever added to, so their highest rowid moves with them and costs one seek,
 * where counting them read every row (58,000 credits) each time. Covers and
 * pictures change in place, so those two are counted; both are small.
 */
export async function libraryStamp(userId: string | null): Promise<string> {
  const row = await env.DB.prepare(
    `SELECT (SELECT max(rated_at) FROM rating WHERE user_id = ?1) AS rated,
            (SELECT count(*) FROM rating WHERE user_id = ?1) AS ratings,
            (SELECT max(rowid) FROM play) AS plays,
            (SELECT max(rowid) FROM artist_credit) AS credits,
            (SELECT max(rowid) FROM genre_tag) AS genres,
            (SELECT max(rowid) FROM artist) AS artists,
            (SELECT max(rowid) FROM release_group) AS releases,
            -- Hand edits: a rename or a picture order changes no count.
            (SELECT max(edited_at) FROM field_override) AS edits,
            -- Pictures found later (a cover, an artist photo) change what pages show.
            (SELECT count(*) FROM release WHERE art_key IS NOT NULL) AS covers,
            (SELECT count(*) FROM artist_image WHERE hidden = 0) AS pictures`,
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
