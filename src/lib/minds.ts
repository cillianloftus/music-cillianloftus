/**
 * Changed your mind: tracks and albums whose latest score has moved a
 * long way from the first, rated again at least a week later. A quick gut
 * score followed the same evening by the full breakdown is refining, not
 * changing your mind, so it is left out.
 */

import { env } from 'cloudflare:workers';

export interface ChangedMind {
  entity_type: 'recording' | 'release_group';
  entity_id: string;
  title: string;
  /** The first score and the latest, 0–100. */
  was: number;
  now: number;
  first_at: string;
  last_at: string;
}

/** Days between the first rating and the latest for it to count. */
export const MIND_GAP_DAYS = 7;
/** Points the score must have moved. */
export const MIND_MARGIN = 8;

export async function changedMinds(userId: string, limit = 8): Promise<ChangedMind[]> {
  const { results } = await env.DB.prepare(
    `WITH r AS (
       SELECT a.entity_type, a.entity_id, a.rated_at,
              max(0.0, min(100.0, 10.0 * coalesce(a.craft_composite, a.gut_score + c.gut_offset))) AS score
       FROM v_rating_axes a JOIN v_gut_calibration c ON c.user_id = a.user_id
       WHERE a.user_id = ?1 AND coalesce(a.craft_composite, a.gut_score) IS NOT NULL
     ),
     span AS (
       SELECT entity_type, entity_id, min(rated_at) AS first_at, max(rated_at) AS last_at
       FROM r GROUP BY entity_type, entity_id
       HAVING julianday(max(rated_at)) - julianday(min(rated_at)) >= ?2
     ),
     moved AS (
       SELECT s.*,
              (SELECT score FROM r WHERE r.entity_type = s.entity_type AND r.entity_id = s.entity_id AND r.rated_at = s.first_at) AS was,
              (SELECT score FROM r WHERE r.entity_type = s.entity_type AND r.entity_id = s.entity_id AND r.rated_at = s.last_at) AS now
       FROM span s
     )
     SELECT m.entity_type, m.entity_id, m.was, m.now, m.first_at, m.last_at,
            coalesce(rec.title, g.title) AS title
     FROM moved m
     LEFT JOIN recording rec ON m.entity_type = 'recording' AND rec.id = m.entity_id
     LEFT JOIN release_group g ON m.entity_type = 'release_group' AND g.id = m.entity_id
     WHERE abs(m.now - m.was) >= ?3
     ORDER BY abs(m.now - m.was) DESC, m.last_at DESC
     LIMIT ?4`,
  )
    .bind(userId, MIND_GAP_DAYS, MIND_MARGIN, limit)
    .all<ChangedMind>();
  return results;
}
