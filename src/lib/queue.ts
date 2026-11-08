/**
 * The rating queue (ARCHITECTURE.md §7): an inbox, one item at a time.
 * Ordering is the feature. Current preference, highest first:
 *
 *   0. opened in Spotify from the queue and not rated since (the loop)
 *   1. albums by artists already rated highly
 *   2. high play count with no rating
 *   3. gut-rated 8 or above with no detailed breakdown
 *   4. recently added
 *   5. albums with some tracks rated but no album rating
 *   6. everything else unrated
 *
 * Skipped items sink below everything unskipped, oldest skip first, so a
 * skip deprioritises without hiding. Thresholds are starting positions.
 */

import { env } from 'cloudflare:workers';

export const QUEUE_RULES = {
  highlyRatedArtist: 80,
  highPlayCount: 10,
  examineGutAtLeast: 8,
  recentDays: 30,
  /** A handoff older than this no longer jumps the queue. */
  handoffHours: 48,
} as const;

export type QueueEntity = 'release_group' | 'recording';

export type QueueReason =
  | { tier: 0; kind: 'handoff' }
  | { tier: 1; kind: 'artist'; artist: string; score: number }
  | { tier: 2; kind: 'plays'; plays: number }
  | { tier: 3; kind: 'examine'; gut: number }
  | { tier: 4; kind: 'recent' }
  | { tier: 5; kind: 'partial'; rated: number }
  | { tier: 6; kind: 'unrated' };

export interface QueueEntry {
  entity_type: QueueEntity;
  entity_id: string;
  reason: QueueReason;
  skipped: boolean;
}

interface Row {
  entity_type: QueueEntity;
  entity_id: string;
  tier: number;
  artist_name: string | null;
  artist_score: number | null;
  plays: number;
  gut: number | null;
  rated_track_count: number | null;
  handed_off: number;
  skipped: number;
}

const QUEUE_SQL = `
WITH
artist_score AS (
  SELECT c.artist_id, avg(s.quality_score) AS score
  FROM artist_credit c
  JOIN v_recording_score s ON s.recording_id = c.entity_id AND s.user_id = ?1
  WHERE c.entity_type = 'recording' AND c.role = 'primary'
  GROUP BY c.artist_id
),
latest_rating AS (
  SELECT entity_type, entity_id, max(rated_at) AS rated_at
  FROM rating WHERE user_id = ?1
  GROUP BY entity_type, entity_id
),
albums AS (
  SELECT
    g.id AS entity_id,
    g.created_at,
    s.rated_track_count,
    (SELECT a.name FROM artist_credit c JOIN artist a ON a.id = c.artist_id
     WHERE c.entity_type = 'release_group' AND c.entity_id = g.id AND c.role = 'primary'
     ORDER BY c.position LIMIT 1) AS artist_name,
    (SELECT max(sc.score) FROM artist_credit c JOIN artist_score sc ON sc.artist_id = c.artist_id
     WHERE c.entity_type = 'release_group' AND c.entity_id = g.id AND c.role = 'primary') AS artist_score,
    (SELECT count(*) FROM play p
     JOIN track t ON t.recording_id = p.recording_id
     JOIN v_release_group_canonical cc ON cc.release_id = t.release_id
     WHERE cc.release_group_id = g.id AND p.user_id = ?1) AS plays
  FROM release_group g
  LEFT JOIN v_release_score s ON s.release_group_id = g.id AND s.user_id = ?1
  WHERE g.status = 'released'
    -- Bootlegs waiting to be cleared are not worth a rating.
    AND (coalesce(g.official, 1) = 1 OR g.keep_unofficial = 1)
    AND NOT EXISTS (SELECT 1 FROM latest_rating lr
                    WHERE lr.entity_type = 'release_group' AND lr.entity_id = g.id)
),
items AS (
  SELECT
    'release_group' AS entity_type, entity_id, artist_name, artist_score, plays,
    NULL AS gut, rated_track_count, created_at,
    CASE
      WHEN artist_score >= ?2 THEN 1
      WHEN plays >= ?3 THEN 2
      WHEN created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ?5 || ' days') THEN 4
      WHEN rated_track_count > 0 THEN 5
      ELSE 6
    END AS tier
  FROM albums
  UNION ALL
  -- Believed excellent but not yet examined: the second tier.
  SELECT
    l.entity_type, l.entity_id, NULL, NULL, 0, l.gut_score, NULL, l.rated_at, 3
  FROM v_latest_rating_axes l
  WHERE l.user_id = ?1 AND l.depth = 'gut' AND l.gut_score >= ?4
    AND NOT EXISTS (SELECT 1 FROM recording_kind k WHERE k.recording_id = l.entity_id AND k.kind = 'skit')
)
SELECT
  i.entity_type, i.entity_id, i.tier, i.artist_name, i.artist_score, i.plays, i.gut, i.rated_track_count,
  (h.opened_at IS NOT NULL
   AND h.opened_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ?6 || ' hours')
   AND h.opened_at > coalesce(lr.rated_at, '')) AS handed_off,
  (k.skipped_at IS NOT NULL AND k.skipped_at > coalesce(h.opened_at, '')) AS skipped
FROM items i
LEFT JOIN queue_handoff h
       ON h.user_id = ?1 AND h.entity_type = i.entity_type AND h.entity_id = i.entity_id
LEFT JOIN queue_skip k
       ON k.user_id = ?1 AND k.entity_type = i.entity_type AND k.entity_id = i.entity_id
LEFT JOIN latest_rating lr
       ON lr.entity_type = i.entity_type AND lr.entity_id = i.entity_id
ORDER BY
  handed_off DESC,
  skipped ASC,
  k.skipped_at ASC,
  i.tier ASC,
  i.artist_score DESC,
  i.plays DESC,
  i.created_at DESC,
  i.entity_id`;

function reasonFor(row: Row): QueueReason {
  if (row.handed_off) return { tier: 0, kind: 'handoff' };
  switch (row.tier) {
    case 1:
      return { tier: 1, kind: 'artist', artist: row.artist_name ?? 'this artist', score: Math.round(row.artist_score ?? 0) };
    case 2:
      return { tier: 2, kind: 'plays', plays: row.plays };
    case 3:
      return { tier: 3, kind: 'examine', gut: row.gut ?? 0 };
    case 4:
      return { tier: 4, kind: 'recent' };
    case 5:
      return { tier: 5, kind: 'partial', rated: row.rated_track_count ?? 0 };
    default:
      return { tier: 6, kind: 'unrated' };
  }
}

export async function ratingQueue(userId: string): Promise<QueueEntry[]> {
  const { results } = await env.DB.prepare(QUEUE_SQL)
    .bind(
      userId,
      QUEUE_RULES.highlyRatedArtist,
      QUEUE_RULES.highPlayCount,
      QUEUE_RULES.examineGutAtLeast,
      QUEUE_RULES.recentDays,
      QUEUE_RULES.handoffHours,
    )
    .all<Row>();
  return results.map((row) => ({
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    reason: reasonFor(row),
    skipped: Boolean(row.skipped),
  }));
}

export async function skip(userId: string, entityType: QueueEntity, entityId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO queue_skip (user_id, entity_type, entity_id) VALUES (?, ?, ?)
     ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE SET
       skip_count = skip_count + 1,
       skipped_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  )
    .bind(userId, entityType, entityId)
    .run();
}

export async function recordHandoff(userId: string, entityType: QueueEntity, entityId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO queue_handoff (user_id, entity_type, entity_id) VALUES (?, ?, ?)
     ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE SET
       opened_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  )
    .bind(userId, entityType, entityId)
    .run();
}
