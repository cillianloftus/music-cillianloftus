/**
 * Versions of a song share its score until rated themselves (0075): a
 * recording of the same work by the same artist, unrated, takes the score
 * of the work's preferred recording when that is rated, else of the version
 * rated most recently. Kept in inherited_score, rebuilt here: after a
 * rating, when gut conversions or weights move scores, nightly, and for an
 * import's new songs. A song's own rating wins at once (the view leaves a
 * borrowed score out the moment one exists), so a rebuild is only ever
 * catching up.
 */

import { env } from 'cloudflare:workers';

/** Each unrated version and the rated one it takes its score from, for one user. */
const PICKS = `
  SELECT recording_id, user_id, quality_score, personal_score, depth, from_recording_id FROM (
    SELECT r.id AS recording_id, o.user_id, o.quality_score, o.personal_score, o.depth, o.recording_id AS from_recording_id,
           row_number() OVER (
             PARTITION BY r.id
             ORDER BY coalesce(w.preferred_recording_id = o.recording_id, 0) DESC, o.rated_at DESC, o.recording_id
           ) AS pick
    FROM v_recording_own_score o
    JOIN recording src ON src.id = o.recording_id AND src.work_id IS NOT NULL
    JOIN recording r ON r.work_id = src.work_id AND r.id <> src.id
    LEFT JOIN work w ON w.id = src.work_id
    WHERE o.user_id = ?1
      AND (?2 IS NULL OR r.id IN (SELECT value FROM json_each(?2)))
      AND NOT EXISTS (SELECT 1 FROM rating x WHERE x.user_id = ?1 AND x.entity_type = 'recording' AND x.entity_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM recording_kind k WHERE k.recording_id = r.id AND k.kind = 'skit')
      -- The same artist's: a cover shares the work, never the score.
      AND EXISTS (SELECT 1 FROM artist_credit ca
                  JOIN artist_credit cb ON cb.artist_id = ca.artist_id AND cb.entity_type = 'recording' AND cb.entity_id = r.id AND cb.role = 'primary'
                  WHERE ca.entity_type = 'recording' AND ca.entity_id = src.id AND ca.role = 'primary')
  ) WHERE pick = 1`;

/**
 * Rebuilds one user's borrowed scores: all of them, or only for the given
 * songs (an import's). Returns how many there are afterwards among those
 * looked at.
 */
export async function rebuildInheritedScores(userId: string, only: string[] | null = null): Promise<number> {
  const scope = only ? JSON.stringify(only) : null;
  const [, inserted] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM inherited_score WHERE user_id = ?1 AND (?2 IS NULL OR recording_id IN (SELECT value FROM json_each(?2)))`).bind(
      userId,
      scope,
    ),
    env.DB.prepare(
      `INSERT INTO inherited_score (recording_id, user_id, quality_score, personal_score, depth, from_recording_id) ${PICKS}`,
    ).bind(userId, scope),
  ]);
  return inserted?.meta.changes ?? 0;
}

/** Every user's: nightly, and when scores move for everyone (weights, gut conversions). */
export async function rebuildAllInheritedScores(): Promise<void> {
  const { results } = await env.DB.prepare(`SELECT DISTINCT user_id FROM rating`).all<{ user_id: string }>();
  for (const { user_id } of results) await rebuildInheritedScores(user_id);
}

/** For songs just imported: any that are versions of a rated song take its score, for every user. */
export async function inheritForNewSongs(recordingIds: string[]): Promise<void> {
  if (recordingIds.length === 0) return;
  const { results } = await env.DB.prepare(`SELECT DISTINCT user_id FROM rating`).all<{ user_id: string }>();
  let added = 0;
  for (const { user_id } of results) added += await rebuildInheritedScores(user_id, recordingIds);
  // Album scores move with it: their caches follow the scores version.
  if (added > 0) {
    await env.DB.prepare(`UPDATE app_setting SET value = CAST(value AS INTEGER) + 1 WHERE key = 'scores_version'`).run();
  }
}
