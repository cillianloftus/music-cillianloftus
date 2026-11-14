/**
 * Keeps gut_conversion (migration 0067): each gut-only song's conversion
 * from gut score to score, by the layers in scoring.ts (calibrate): the
 * general gap, the gut level, the artist, the genres.
 *
 * When it changes:
 * - A gut-only rating: that one song, at once, from the calibration last
 *   worked out (kept in KV). Rating by gut never changes the calibration
 *   itself: only songs rated both ways feed it.
 * - A detailed rating, or a gut one in place of a detailed one: the
 *   calibration may move, so the whole table (and the general gap in
 *   gut_calibration, migration 0069) is worked out again on the next cron
 *   minute (markStale), not inside the save, which the autosave makes often.
 * - New weights, and each night (an artist credited or a genre added since).
 *
 * Only rows that changed are written, and the scores' cache version moves
 * when any did, so kept album scores are worked out again.
 */

import { env } from 'cloudflare:workers';
import { calibrate, convert, gutConversions, type Calibration } from './scoring';
import { activeWeights, scoreInputs } from './weights';
import { genresOfRecordings } from './genres';

const staleKey = (userId: string) => `gut-stale:${userId}`;
const calibrationKey = (userId: string) => `gut-calibration:${userId}`;

const BUMP_SCORES = `INSERT INTO app_setting (key, value) VALUES ('scores_version', '1')
                     ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`;

/** KV, where there is one: without it (tests) everything is just worked out. */
async function kv<T>(work: (cache: KVNamespace) => Promise<T>, otherwise: T): Promise<T> {
  try {
    return env.CACHE ? await work(env.CACHE) : otherwise;
  } catch {
    return otherwise;
  }
}

/** The calibration last worked out for this listener, or null. */
export function keptCalibration(userId: string): Promise<Calibration | null> {
  return kv((cache) => cache.get<Calibration>(calibrationKey(userId), 'json'), null);
}

/** Work the whole table out again on the next cron minute. */
export async function markStale(userId: string): Promise<void> {
  await kv((cache) => cache.put(staleKey(userId), '1'), undefined);
}

/** Works out every gut-only song's conversion again; returns how many rows changed. */
export async function rebuildGutConversions(userId: string): Promise<number> {
  const [inputs, weights] = await Promise.all([scoreInputs(userId, { albums: false }), activeWeights(userId)]);
  const cal = calibrate(inputs, weights);
  const want = gutConversions(inputs, weights, cal);
  const { results: held } = await env.DB.prepare('SELECT recording_id, gut_offset FROM gut_conversion WHERE user_id = ?')
    .bind(userId)
    .all<{ recording_id: string; gut_offset: number }>();
  const had = new Map(held.map((r) => [r.recording_id, r.gut_offset]));

  const statements: D1PreparedStatement[] = [];
  for (const [id, offset] of want) {
    if (had.get(id) === offset) continue;
    statements.push(
      env.DB.prepare(
        `INSERT INTO gut_conversion (user_id, recording_id, gut_offset) VALUES (?, ?, ?)
         ON CONFLICT (user_id, recording_id) DO UPDATE SET gut_offset = excluded.gut_offset`,
      ).bind(userId, id, offset),
    );
  }
  for (const id of had.keys()) {
    if (!want.has(id)) statements.push(env.DB.prepare('DELETE FROM gut_conversion WHERE user_id = ? AND recording_id = ?').bind(userId, id));
  }
  // The general gap, which v_gut_calibration reads (migration 0069).
  const general = await env.DB.prepare('SELECT gut_offset, sample_size FROM gut_calibration WHERE user_id = ?')
    .bind(userId)
    .first<{ gut_offset: number; sample_size: number }>();
  if (general?.gut_offset !== cal.general || general?.sample_size !== cal.samples) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO gut_calibration (user_id, gut_offset, sample_size) VALUES (?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET gut_offset = excluded.gut_offset, sample_size = excluded.sample_size`,
      ).bind(userId, cal.general, cal.samples),
    );
  }
  if (statements.length > 0) {
    statements.push(env.DB.prepare(BUMP_SCORES));
    for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100));
  }
  await kv((cache) => cache.put(calibrationKey(userId), JSON.stringify(cal)), undefined);
  return statements.length === 0 ? 0 : statements.length - 1;
}

/** One gut-only song's conversion, at once, from the kept calibration (or a full rebuild if none is kept). */
export async function convertOne(userId: string, recordingId: string, gut: number): Promise<void> {
  const cal = await keptCalibration(userId);
  if (!cal) {
    await rebuildGutConversions(userId);
    return;
  }
  const [artist, genres] = await env.DB.batch([
    env.DB.prepare(
      `SELECT artist_id FROM artist_credit
       WHERE entity_type = 'recording' AND entity_id = ? AND role = 'primary' ORDER BY position LIMIT 1`,
    ).bind(recordingId),
    env.DB.prepare(`WITH one AS (SELECT ? AS recording_id) ${genresOfRecordings('one')}`).bind(recordingId),
  ]);
  const artistId = (artist!.results[0] as { artist_id: string } | undefined)?.artist_id;
  const genreIds = (genres!.results as { genre_id: string }[]).map((g) => g.genre_id);
  const { offset } = convert(cal, gut, artistId, genreIds);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO gut_conversion (user_id, recording_id, gut_offset) VALUES (?, ?, ?)
       ON CONFLICT (user_id, recording_id) DO UPDATE SET gut_offset = excluded.gut_offset`,
    ).bind(userId, recordingId, offset),
    env.DB.prepare(BUMP_SCORES),
  ]);
}

/** The cron's minute: the listeners whose calibration is stale, or never worked out. */
export async function rebuildStaleGutConversions(): Promise<void> {
  // The few listeners, not the ratings: this runs every minute.
  const { results } = await env.DB.prepare(`SELECT id AS user_id FROM app_user`).all<{ user_id: string }>();
  for (const { user_id } of results) {
    const stale = await kv((cache) => cache.get(staleKey(user_id)), null);
    if (!stale && (await keptCalibration(user_id))) continue;
    await kv((cache) => cache.delete(staleKey(user_id)), undefined);
    await rebuildGutConversions(user_id).catch((error) => console.warn('Gut calibration failed', user_id, error));
  }
}

/** Each night: every listener, whatever is marked. */
export async function rebuildAllGutConversions(): Promise<void> {
  const { results } = await env.DB.prepare(`SELECT id AS user_id FROM app_user`).all<{ user_id: string }>();
  for (const { user_id } of results) await rebuildGutConversions(user_id);
}
