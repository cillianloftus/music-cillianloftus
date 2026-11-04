/**
 * The data a playlist's art is drawn from: for each result, its score,
 * year, main genre and that genre's family. Runs the definition through the
 * same compiler as the page and the Spotify push, so the art always
 * describes exactly what the playlist holds.
 */

import { env } from 'cloudflare:workers';
import type { SavedDefinition } from '../definitions';
import { selectIds } from '../query/run';
import type { ArtItem } from './playlist';

const ROOTS = `WITH RECURSIVE up(id, root_id) AS (
  SELECT id, id FROM genre WHERE parent_id IS NULL
  UNION ALL
  SELECT g.id, up.root_id FROM genre g JOIN up ON g.parent_id = up.id
)`;

const SQL = {
  recording: `${ROOTS}
    SELECT x.score, x.year, g.name AS genre, root.name AS root
    FROM (
      SELECT e.id,
             s.quality_score AS score,
             CAST(substr(coalesce(e.first_release_date, ag.first_release_date), 1, 4) AS INTEGER) AS year,
             (SELECT vg.genre_id FROM v_recording_genre vg WHERE vg.recording_id = e.id
              ORDER BY vg.weight DESC, vg.genre_id LIMIT 1) AS genre_id
      FROM recording e
      LEFT JOIN v_recording_score s ON s.recording_id = e.id AND s.user_id = ?1
      LEFT JOIN v_recording_album ra ON ra.recording_id = e.id
      LEFT JOIN release_group ag ON ag.id = ra.release_group_id
      WHERE e.id IN (SELECT value FROM json_each(?2))
    ) x
    LEFT JOIN genre g ON g.id = x.genre_id
    LEFT JOIN up ON up.id = x.genre_id
    LEFT JOIN genre root ON root.id = up.root_id`,
  release_group: `${ROOTS}
    SELECT x.score, x.year, g.name AS genre, root.name AS root
    FROM (
      SELECT e.id,
             s.quality_score AS score,
             CAST(substr(e.first_release_date, 1, 4) AS INTEGER) AS year,
             (SELECT vg.genre_id FROM v_release_group_genre vg WHERE vg.release_group_id = e.id
              ORDER BY vg.weight DESC, vg.genre_id LIMIT 1) AS genre_id
      FROM release_group e
      LEFT JOIN v_release_score s ON s.release_group_id = e.id AND s.user_id = ?1
      WHERE e.id IN (SELECT value FROM json_each(?2))
    ) x
    LEFT JOIN genre g ON g.id = x.genre_id
    LEFT JOIN up ON up.id = x.genre_id
    LEFT JOIN genre root ON root.id = up.root_id`,
} as const;

export async function artItems(saved: SavedDefinition): Promise<ArtItem[]> {
  const entity = saved.definition.entity;
  if (entity !== 'recording' && entity !== 'release_group') return [];
  const ids = await selectIds(saved.definition, { userId: saved.user_id, pins: saved.pins, excludes: saved.excludes });
  if (ids.length === 0) return [];
  const { results } = await env.DB.prepare(SQL[entity]).bind(saved.user_id, JSON.stringify(ids)).all<ArtItem>();
  return results;
}
