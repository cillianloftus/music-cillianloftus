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

export async function roster(viewerId: string | null, sort: RosterSort = 'score'): Promise<RosterArtist[]> {
  const orders: Record<RosterSort, string> = {
    // Rated artists by score; the unrated after, by how much of theirs is here.
    score: 'average IS NULL, average DESC, rated DESC, releases DESC, a.sort_name COLLATE NOCASE',
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
            (SELECT count(*) FROM artist_credit c WHERE c.artist_id = a.id AND c.entity_type = 'release_group' AND c.role = 'primary') AS releases,
            (SELECT count(*) FROM artist_credit c JOIN v_recording_score s ON s.recording_id = c.entity_id AND s.user_id = ?1
             WHERE c.artist_id = a.id AND c.entity_type = 'recording' AND c.role = 'primary') AS rated,
            (SELECT avg(s.quality_score) FROM artist_credit c JOIN v_recording_score s ON s.recording_id = c.entity_id AND s.user_id = ?1
             WHERE c.artist_id = a.id AND c.entity_type = 'recording' AND c.role = 'primary') AS average
     FROM artist a JOIN own ON own.artist_id = a.id
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
