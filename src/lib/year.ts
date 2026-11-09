/**
 * A year in review, from the ratings and plays alone: what came out that
 * year and how it scored, what was discovered and loved, which artists
 * became favourites, when the rating happened, and what that year's
 * ratings show that the others don't. Nothing is chosen by hand; a quiet
 * year has a short page.
 */

import { env } from 'cloudflare:workers';
import { albumScores } from './album-scores';
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
  /** The music that came out this year, whenever it was rated. */
  released: {
    /** Albums, mixtapes and EPs out this year, in the library. */
    albums: number;
    /** Tracks out this year that have been rated, and their average. */
    rated: number;
    average: number | null;
    /** The best of them, best first. */
    best: string[];
    /** Artists by their average across this year's tracks, at least two. */
    artists: { id: string; name: string; average: number; tracks: number }[];
  };
}

export async function yearInReview(userId: string, year: number): Promise<YearReview> {
  const from = `${year}-01-01`;
  const to = `${year + 1}-01-01`;
  const scores = await albumScores(userId);
  const [totals, releases, discoveries, found, months, years, outTotals, outBest, outArtists] = await env.DB.batch([
    env.DB.prepare(
      `WITH firsts AS (
         SELECT entity_id, min(rated_at) AS first FROM rating WHERE user_id = ?1 AND entity_type = 'recording' GROUP BY entity_id
       )
       SELECT (SELECT count(*) FROM firsts WHERE first >= ?2 AND first < ?3) AS rated,
              (SELECT avg(s.quality_score) FROM firsts f JOIN v_recording_score s ON s.recording_id = f.entity_id AND s.user_id = ?1
               WHERE f.first >= ?2 AND f.first < ?3) AS average,
              (SELECT count(*) FROM play WHERE user_id = ?1 AND played_at >= ?2 AND played_at < ?3 AND counted = 1) AS plays,
              (SELECT count(*) FROM (
                 SELECT c.artist_id, min(f.first) AS met FROM firsts f
                 JOIN artist_credit c ON c.entity_type = 'recording' AND c.entity_id = f.entity_id AND c.role = 'primary'
                 GROUP BY c.artist_id
               ) WHERE met >= ?2 AND met < ?3) AS new_artists`,
    ).bind(userId, from, to),
    env.DB.prepare(
      // The year's albums; their scores come from albumScores, below.
      `SELECT g.id FROM release_group g
       WHERE g.first_release_date >= ?2 AND g.first_release_date < ?3 AND g.type IN ('album', 'mixtape', 'ep')
         AND ?1 IS NOT NULL`,
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
       UNION SELECT DISTINCT CAST(substr(played_at, 1, 4) AS INTEGER) FROM play WHERE user_id = ?1 AND counted = 1
       UNION SELECT DISTINCT CAST(substr(r.first_release_date, 1, 4) AS INTEGER) FROM v_recording_score s
             JOIN recording r ON r.id = s.recording_id WHERE s.user_id = ?1 AND r.first_release_date IS NOT NULL
       ORDER BY y DESC`,
    ).bind(userId),
    // The music of the year: what came out in it, however long after it was rated.
    env.DB.prepare(
      `SELECT (SELECT count(*) FROM release_group WHERE first_release_date >= ?2 AND first_release_date < ?3
                 AND type IN ('album', 'mixtape', 'ep') AND (coalesce(official, 1) = 1 OR keep_unofficial = 1)) AS albums,
              count(s.recording_id) AS rated, avg(s.quality_score) AS average
       FROM v_recording_score s JOIN recording r ON r.id = s.recording_id
       WHERE s.user_id = ?1 AND r.first_release_date >= ?2 AND r.first_release_date < ?3`,
    ).bind(userId, from, to),
    env.DB.prepare(
      `SELECT s.recording_id AS id FROM v_recording_score s JOIN recording r ON r.id = s.recording_id
       WHERE s.user_id = ?1 AND r.first_release_date >= ?2 AND r.first_release_date < ?3
       ORDER BY s.personal_score DESC, s.quality_score DESC LIMIT 15`,
    ).bind(userId, from, to),
    env.DB.prepare(
      `SELECT a.id, a.name, avg(s.quality_score) AS average, count(*) AS tracks
       FROM v_recording_score s JOIN recording r ON r.id = s.recording_id
       JOIN artist_credit c ON c.entity_type = 'recording' AND c.entity_id = r.id AND c.role = 'primary'
       JOIN artist a ON a.id = c.artist_id
       WHERE s.user_id = ?1 AND r.first_release_date >= ?2 AND r.first_release_date < ?3
       GROUP BY a.id HAVING count(*) >= 2
       ORDER BY average DESC, tracks DESC LIMIT 8`,
    ).bind(userId, from, to),
  ]);
  const out = outTotals!.results[0] as { albums: number; rated: number; average: number | null };

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
    releases: (releases!.results as { id: string }[])
      .map((r) => r.id)
      .filter((id) => scores[id])
      .sort((a, b) => scores[b]!.quality - scores[a]!.quality || a.localeCompare(b))
      .slice(0, 12),
    discoveries: (discoveries!.results as { id: string }[]).map((r) => r.id),
    found: found!.results as YearReview['found'],
    months: allMonths,
    findings,
    years: (years!.results as { y: number }[]).map((r) => r.y).filter((y) => y > 1900),
    released: {
      albums: out.albums,
      rated: out.rated,
      average: out.average,
      best: (outBest!.results as { id: string }[]).map((r) => r.id),
      artists: outArtists!.results as YearReview['released']['artists'],
    },
  };
}

