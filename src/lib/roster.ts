/**
 * Every artist with music of their own in the catalogue (credited as the
 * artist on an album or track, not only as a writer or producer), for the
 * artists index: a face for each (their own picture, else their latest
 * cover), how much of theirs is here, and how it scores.
 */

import { artistRank } from './artist-rank';
import { env } from 'cloudflare:workers';

export interface RosterArtist {
  id: string;
  name: string;
  sort_name: string;
  kind: string | null;
  image_key: string | null;
  art_key: string | null;
  created_at: string;
  releases: number;
  rated: number;
  average: number | null;
}

export interface Roster {
  artists: RosterArtist[];
  /** The viewer's average track score, which thin averages are pulled toward. */
  mean: number | null;
}

export type RosterSort = 'score' | 'rated' | 'releases' | 'recent' | 'name';


/**
 * Every artist with music of their own, unordered: one read serves every
 * sort, so a library change rebuilds the list once rather than per order.
 * The newest cover is picked from canonical editions worked out once for
 * the whole library; asked per artist, the canonical view was re-derived
 * for every album each time (some 1.5M rows read per build).
 */
export async function roster(viewerId: string | null): Promise<Roster> {
  const { results } = await env.DB.prepare(
    `WITH own AS (
       -- One pass over the credits: who has music of their own, and how many releases.
       SELECT artist_id, sum(entity_type = 'release_group') AS releases
       FROM artist_credit WHERE role = 'primary' AND entity_type IN ('release_group', 'recording')
       GROUP BY artist_id
     ),
     canon AS MATERIALIZED (SELECT release_group_id, release_id FROM v_release_group_canonical),
     -- Their newest album with a cover; max() picks the art_key of the row it chooses.
     covers AS (
       SELECT c.artist_id, r.art_key, max(coalesce(g.first_release_date, '')) AS released
       FROM artist_credit c
       JOIN canon v ON v.release_group_id = c.entity_id
       JOIN release r ON r.id = v.release_id AND r.art_key IS NOT NULL
       JOIN release_group g ON g.id = c.entity_id
       WHERE c.entity_type = 'release_group' AND c.role = 'primary'
       GROUP BY c.artist_id
     )
     SELECT a.id, a.name, a.sort_name, a.kind, a.created_at,
            (SELECT i.key FROM artist_image i WHERE i.artist_id = a.id AND i.hidden = 0 ORDER BY i.position, i.key LIMIT 1) AS image_key,
            covers.art_key,
            own.releases,
            coalesce(scored.rated, 0) AS rated,
            scored.average,
            norm.mean
     FROM artist a JOIN own ON own.artist_id = a.id
     CROSS JOIN (SELECT avg(quality_score) AS mean FROM v_recording_score WHERE user_id = ?1) norm
     LEFT JOIN covers ON covers.artist_id = a.id
     -- Grouped once, not a scoring subquery per artist (thousands of them).
     LEFT JOIN (SELECT c.artist_id, avg(s.quality_score) AS average, count(*) AS rated
                FROM artist_credit c JOIN v_recording_score s ON s.recording_id = c.entity_id AND s.user_id = ?1
                WHERE c.entity_type = 'recording' AND c.role = 'primary' GROUP BY c.artist_id) scored ON scored.artist_id = a.id`,
  )
    .bind(viewerId)
    .all<RosterArtist & { mean: number | null }>();
  const mean = results[0]?.mean ?? null;
  return { artists: results.map(({ mean: _, ...a }) => a), mean };
}

/** Like SQLite's NOCASE: ASCII letters fold, everything else compares as is. */
const nocase = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const byName = (a: RosterArtist, b: RosterArtist) => {
  const x = nocase(a.sort_name), y = nocase(b.sort_name);
  return x < y ? -1 : x > y ? 1 : 0;
};
/** Higher first, missing last. */
const desc = (x: number | null, y: number | null) => (x === y ? 0 : x === null ? 1 : y === null ? -1 : y - x);

/**
 * The roster in one order. By score, each average is as sure as the
 * ratings behind it (artist-rank.ts), so one 99 does not outrank twenty
 * tracks averaging 95; the unrated follow, by how much of theirs is here.
 */
export function sortRoster({ artists, mean }: Roster, sort: RosterSort): RosterArtist[] {
  const weighed = (a: RosterArtist) =>
    a.average === null ? null : mean === null ? a.average : artistRank(a.average, a.rated, mean);
  const orders: Record<RosterSort, (a: RosterArtist, b: RosterArtist) => number> = {
    score: (a, b) => desc(weighed(a), weighed(b)) || b.rated - a.rated || b.releases - a.releases || byName(a, b),
    rated: (a, b) => b.rated - a.rated || desc(a.average, b.average) || b.releases - a.releases || byName(a, b),
    releases: (a, b) => b.releases - a.releases || desc(a.average, b.average) || byName(a, b),
    recent: (a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0) || byName(a, b),
    name: byName,
  };
  return [...artists].sort(orders[sort]);
}

/** The letter an artist files under: A–Z, or # for anything else. */
export function initial(sortName: string): string {
  const first = sortName.normalize('NFKD').replace(/\p{M}/gu, '').trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(first) ? first : '#';
}
