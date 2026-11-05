/**
 * A year in review, from the ratings and plays alone: what came out that
 * year and how it scored, what was discovered and loved, which artists
 * became favourites, when the rating happened, and what that year's
 * ratings show that the others don't. Nothing is chosen by hand; a quiet
 * year has a short page.
 */

import { env } from 'cloudflare:workers';
import { discover, trackFacts, type Finding } from './discover';

export interface YearReview {
  year: number;
  /** Tracks first rated this year. */
  rated: number;
  /** Their average. */
  average: number | null;
  /** Artists whose first rated track was this year. */
  newArtists: number;
  plays: number;
  /** Albums out this year, by score. */
  releases: string[];
  /** Tracks first rated this year, best first. */
  discoveries: string[];
  /** Artists first rated this year, by average, with at least three tracks. */
  found: { id: string; name: string; average: number; tracks: number }[];
  months: { month: string; count: number }[];
  /** Patterns in this year's ratings. */
  findings: Finding[];
  /** Years with ratings or releases, for moving between pages. */
  years: number[];
}

export async function yearInReview(userId: string, year: number): Promise<YearReview> {
  const from = `${year}-01-01`;
  const to = `${year + 1}-01-01`;
  const [totals, releases, discoveries, found, months, years] = await env.DB.batch([
    env.DB.prepare(
      `WITH firsts AS (
         SELECT entity_id, min(rated_at) AS first FROM rating WHERE user_id = ?1 AND entity_type = 'recording' GROUP BY entity_id
       )
       SELECT (SELECT count(*) FROM firsts WHERE first >= ?2 AND first < ?3) AS rated,
              (SELECT avg(s.quality_score) FROM firsts f JOIN v_recording_score s ON s.recording_id = f.entity_id AND s.user_id = ?1
               WHERE f.first >= ?2 AND f.first < ?3) AS average,
              (SELECT count(*) FROM play WHERE user_id = ?1 AND played_at >= ?2 AND played_at < ?3) AS plays,
              (SELECT count(*) FROM (
                 SELECT c.artist_id, min(f.first) AS met FROM firsts f
                 JOIN artist_credit c ON c.entity_type = 'recording' AND c.entity_id = f.entity_id AND c.role = 'primary'
                 GROUP BY c.artist_id
               ) WHERE met >= ?2 AND met < ?3) AS new_artists`,
    ).bind(userId, from, to),
    env.DB.prepare(
      `SELECT s.release_group_id AS id FROM v_release_score s JOIN release_group g ON g.id = s.release_group_id
       WHERE s.user_id = ?1 AND g.first_release_date >= ?2 AND g.first_release_date < ?3 AND g.type IN ('album', 'mixtape', 'ep')
       ORDER BY s.quality_score DESC LIMIT 12`,
    ).bind(userId, from, to),
    env.DB.prepare(
      `WITH firsts AS (
         SELECT entity_id, min(rated_at) AS first FROM rating WHERE user_id = ?1 AND entity_type = 'recording' GROUP BY entity_id
       )
       SELECT f.entity_id AS id FROM firsts f JOIN v_recording_score s ON s.recording_id = f.entity_id AND s.user_id = ?1
       WHERE f.first >= ?2 AND f.first < ?3
       ORDER BY s.personal_score DESC, s.quality_score DESC LIMIT 15`,
    ).bind(userId, from, to),
    env.DB.prepare(
      `WITH firsts AS (
         SELECT entity_id, min(rated_at) AS first FROM rating WHERE user_id = ?1 AND entity_type = 'recording' GROUP BY entity_id
       ),
       per_artist AS (
         SELECT c.artist_id, min(f.first) AS met, avg(s.quality_score) AS average, count(*) AS tracks
         FROM firsts f
         JOIN artist_credit c ON c.entity_type = 'recording' AND c.entity_id = f.entity_id AND c.role = 'primary'
         JOIN v_recording_score s ON s.recording_id = f.entity_id AND s.user_id = ?1
         GROUP BY c.artist_id
       )
       SELECT a.id, a.name, p.average, p.tracks FROM per_artist p JOIN artist a ON a.id = p.artist_id
       WHERE p.met >= ?2 AND p.met < ?3 AND p.tracks >= 3
       ORDER BY p.average DESC LIMIT 8`,
    ).bind(userId, from, to),
    env.DB.prepare(
      `WITH firsts AS (
         SELECT entity_id, min(rated_at) AS first FROM rating WHERE user_id = ?1 AND entity_type = 'recording' GROUP BY entity_id
       )
       SELECT substr(first, 1, 7) AS month, count(*) AS count FROM firsts WHERE first >= ?2 AND first < ?3 GROUP BY month ORDER BY month`,
    ).bind(userId, from, to),
    env.DB.prepare(
      `SELECT DISTINCT CAST(substr(rated_at, 1, 4) AS INTEGER) AS y FROM rating WHERE user_id = ?1
       UNION SELECT DISTINCT CAST(substr(played_at, 1, 4) AS INTEGER) FROM play WHERE user_id = ?1
       ORDER BY y DESC`,
    ).bind(userId),
  ]);

  const t = totals!.results[0] as { rated: number; average: number | null; plays: number; new_artists: number };
  // Every month of the year, so a quiet one shows as quiet.
  const counts = new Map((months!.results as { month: string; count: number }[]).map((m) => [m.month, m.count]));
  const allMonths = Array.from({ length: 12 }, (_, i) => {
    const month = `${year}-${String(i + 1).padStart(2, '0')}`;
    return { month, count: counts.get(month) ?? 0 };
  });

  // This year's ratings against all the others: what was different about it.
  const facts = await trackFacts(userId);
  const thisYear = facts.filter((f) => f.ratedAt && f.ratedAt >= from && f.ratedAt < to);
  const findings = thisYear.length >= 6 ? discover(thisYear, { limit: 6 }).filter((f) => f.kind !== 'habit') : [];

  return {
    year,
    rated: t.rated,
    average: t.average,
    newArtists: t.new_artists,
    plays: t.plays,
    releases: (releases!.results as { id: string }[]).map((r) => r.id),
    discoveries: (discoveries!.results as { id: string }[]).map((r) => r.id),
    found: found!.results as YearReview['found'],
    months: allMonths,
    findings,
    years: (years!.results as { y: number }[]).map((r) => r.y).filter((y) => y > 1900),
  };
}

