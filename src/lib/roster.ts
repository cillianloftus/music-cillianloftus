/**
 * Every artist with music of their own in the catalogue (credited as the
 * artist on an album or track, not only as a writer or producer), for the
 * artists index: a face for each (their own picture, else their latest
 * cover), how much of theirs is here, and how it scores.
 */

import { env } from 'cloudflare:workers';

export interface RosterArtist {
  id: string;
  name: string;
  sort_name: string;
  kind: string | null;
  image_key: string | null;
  art_key: string | null;
  releases: number;
  rated: number;
  average: number | null;
}

export type RosterSort = 'score' | 'rated' | 'releases' | 'recent' | 'name';

/**
 * For ordering by score: each artist's average is pulled toward the
 * viewer's overall track average as if this many more tracks had been
 * rated at it. One rated track barely moves an artist from the norm;
 * twenty mostly speak for themselves. The average shown is never adjusted.
 */
export const EVIDENCE = 4;

export async function roster(viewerId: string | null, sort: RosterSort = 'score'): Promise<RosterArtist[]> {
  const orders: Record<RosterSort, string> = {
    // Rated artists by score; the unrated after, by how much of theirs is here.
    // The score is weighed by how much stands behind it (see EVIDENCE), so one
    // 99 does not outrank twenty tracks averaging 95.
    score: `average IS NULL, (scored.average * scored.rated + norm.mean * ${EVIDENCE}) / (scored.rated + ${EVIDENCE}) DESC, rated DESC, releases DESC, a.sort_name COLLATE NOCASE`,
    rated: 'rated DESC, average DESC, releases DESC, a.sort_name COLLATE NOCASE',
    releases: 'releases DESC, average IS NULL, average DESC, a.sort_name COLLATE NOCASE',
    recent: 'a.created_at DESC, a.sort_name COLLATE NOCASE',
    name: 'a.sort_name COLLATE NOCASE',
  };
  const order = orders[sort];
  const { results } = await env.DB.prepare(
    `WITH own AS (
       SELECT DISTINCT artist_id FROM artist_credit WHERE role = 'primary' AND entity_type IN ('release_group', 'recording')
     )
     SELECT a.id, a.name, a.sort_name, a.kind,
            (SELECT i.key FROM artist_image i WHERE i.artist_id = a.id AND i.hidden = 0 ORDER BY i.position, i.key LIMIT 1) AS image_key,
            (SELECT r.art_key FROM artist_credit c
               JOIN v_release_group_canonical v ON v.release_group_id = c.entity_id
               JOIN release r ON r.id = v.release_id
               JOIN release_group g ON g.id = c.entity_id
             WHERE c.artist_id = a.id AND c.entity_type = 'release_group' AND c.role = 'primary' AND r.art_key IS NOT NULL
             ORDER BY g.first_release_date DESC LIMIT 1) AS art_key,
            coalesce(released.releases, 0) AS releases,
            coalesce(scored.rated, 0) AS rated,
            scored.average
     FROM artist a JOIN own ON own.artist_id = a.id
     CROSS JOIN (SELECT avg(quality_score) AS mean FROM v_recording_score WHERE user_id = ?1) norm
     -- Grouped once, not a scoring subquery per artist (thousands of them).
     LEFT JOIN (SELECT c.artist_id, avg(s.quality_score) AS average, count(*) AS rated
                FROM artist_credit c JOIN v_recording_score s ON s.recording_id = c.entity_id AND s.user_id = ?1
                WHERE c.entity_type = 'recording' AND c.role = 'primary' GROUP BY c.artist_id) scored ON scored.artist_id = a.id
     LEFT JOIN (SELECT artist_id, count(*) AS releases FROM artist_credit
                WHERE entity_type = 'release_group' AND role = 'primary' GROUP BY artist_id) released ON released.artist_id = a.id
     ORDER BY ${order}`,
  )
    .bind(viewerId)
    .all<RosterArtist>();
  return results;
}

/** The letter an artist files under: A–Z, or # for anything else. */
export function initial(sortName: string): string {
  const first = sortName.normalize('NFKD').replace(/\p{M}/gu, '').trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(first) ? first : '#';
}
