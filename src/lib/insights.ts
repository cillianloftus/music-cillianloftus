/**
 * What the ratings say about the person making them: how scores spread,
 * which decades and genre families score highest, how gut and considered
 * judgement differ, how often impact is given, and when the rating
 * happened. All from the score views; nothing stored.
 */

import { env } from 'cloudflare:workers';
import { albumScores, type ScoredAlbum } from './album-scores';
import { genresOfRecordings } from './genres';

export interface Headline {
  ratedTracks: number;
  ratedAlbums: number;
  averageTrack: number | null;
  /** Considered minus gut, in points out of 100: positive means the gut runs low. */
  gutOffset: number;
  gutSamples: number;
  impactTracks: number;
}

export interface Bin {
  from: number;
  to: number;
  count: number;
}

export interface Group {
  key: string;
  label: string;
  average: number;
  count: number;
}

export interface Month {
  month: string;
  count: number;
}

export interface ArtistRow {
  id: string;
  name: string;
  tracks: number;
  average: number;
}

export interface Insights {
  headline: Headline;
  spread: Bin[];
  decades: Group[];
  /** Tracks by the year they came out, newest first: the way into each year's page. */
  years: Group[];
  families: Group[];
  months: Month[];
  artists: ArtistRow[];
}

export async function insights(userId: string): Promise<Insights> {
  // Albums come from the user's album scores (album-scores.ts), read alongside.
  const [batch, scores] = await Promise.all([env.DB.batch([
    env.DB.prepare(
      `SELECT (SELECT count(*) FROM v_recording_score WHERE user_id = ?1) AS ratedTracks,
              (SELECT avg(quality_score) FROM v_recording_score WHERE user_id = ?1) AS averageTrack,
              (SELECT gut_offset FROM v_gut_calibration WHERE user_id = ?1) AS gutOffset,
              (SELECT sample_size FROM v_gut_calibration WHERE user_id = ?1) AS gutSamples,
              (SELECT count(*) FROM v_recording_score WHERE user_id = ?1 AND personal_score > quality_score) AS impactTracks`,
    ).bind(userId),
    // Ten-point bands; 100 belongs to the top band.
    env.DB.prepare(
      `SELECT min(9, CAST(quality_score / 10 AS INTEGER)) AS band, count(*) AS count
       FROM v_recording_score WHERE user_id = ? GROUP BY band`,
    ).bind(userId),
    // Genre families: a track's genres, walked up primary parents to the root.
    env.DB.prepare(
      `WITH RECURSIVE up(id, root_id) AS (
         SELECT id, id FROM genre WHERE parent_id IS NULL
         UNION ALL
         SELECT g.id, up.root_id FROM genre g JOIN up ON g.parent_id = up.id
       ),
       -- Rated tracks to their genres (genresOfRecordings): through the
       -- genre view, built whole, this read 135,000 rows.
       scored AS (SELECT recording_id, quality_score FROM v_recording_score WHERE user_id = ?1),
       pairs AS (${genresOfRecordings('scored')}),
       tagged AS (
         SELECT DISTINCT p.recording_id, up.root_id
         FROM pairs p JOIN up ON up.id = p.genre_id
       )
       SELECT r.name AS key, r.name AS label, avg(s.quality_score) AS average, count(*) AS count
       FROM tagged t
       JOIN scored s ON s.recording_id = t.recording_id
       JOIN genre r ON r.id = t.root_id
       GROUP BY t.root_id
       HAVING count(*) >= 2
       ORDER BY average DESC, count DESC
       LIMIT 12`,
    ).bind(userId),
    env.DB.prepare(
      `SELECT substr(rated_at, 1, 7) AS month, count(*) AS count FROM rating WHERE user_id = ? GROUP BY month ORDER BY month`,
    ).bind(userId),
    env.DB.prepare(
      `SELECT a.id, a.name, count(*) AS tracks, avg(s.quality_score) AS average
       FROM v_recording_score s
       JOIN artist_credit c ON c.entity_type = 'recording' AND c.entity_id = s.recording_id AND c.role = 'primary' AND c.position = 1
       JOIN artist a ON a.id = c.artist_id
       WHERE s.user_id = ?
       GROUP BY a.id
       ORDER BY tracks DESC, average DESC
       LIMIT 8`,
    ).bind(userId),
    env.DB.prepare(
      `SELECT substr(r.first_release_date, 1, 4) AS key, avg(s.quality_score) AS average, count(*) AS count
       FROM v_recording_score s JOIN recording r ON r.id = s.recording_id
       WHERE s.user_id = ? AND r.first_release_date IS NOT NULL
       GROUP BY key ORDER BY key DESC`,
    ).bind(userId),
  ]), albumScores(userId)]);
  const [headline, spread, families, months, artists, years] = batch;

  const h = (headline!.results[0] ?? {}) as Record<string, number | null>;
  const bands = new Map((spread!.results as { band: number; count: number }[]).map((r) => [r.band, r.count]));
  return {
    headline: {
      ratedTracks: h.ratedTracks ?? 0,
      ratedAlbums: Object.keys(scores).length,
      averageTrack: h.averageTrack ?? null,
      gutOffset: (h.gutOffset ?? 0) * 10,
      gutSamples: h.gutSamples ?? 0,
      impactTracks: h.impactTracks ?? 0,
    },
    spread: Array.from({ length: 10 }, (_, band) => ({ from: band * 10, to: band === 9 ? 100 : band * 10 + 9, count: bands.get(band) ?? 0 })),
    decades: byDecade(Object.values(scores)),
    years: (years!.results as Group[]).filter((y) => /^\d{4}$/.test(y.key)),
    families: families!.results as Group[],
    months: fillMonths(months!.results as Month[]),
    artists: artists!.results as ArtistRow[],
  };
}

/** Average album score by decade of release, oldest first; undated albums left out. */
export function byDecade(albums: Pick<ScoredAlbum, 'quality' | 'released'>[]): Group[] {
  const decades = new Map<string, { sum: number; count: number }>();
  for (const album of albums) {
    if (!album.released) continue;
    const key = `${album.released.slice(0, 3)}0s`;
    const d = decades.get(key) ?? { sum: 0, count: 0 };
    d.sum += album.quality;
    d.count += 1;
    decades.set(key, d);
  }
  return [...decades]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, d]) => ({ key, label: key, average: d.sum / d.count, count: d.count }));
}

/** Every month from the first to the last, zero where nothing was rated. */
export function fillMonths(rows: Month[]): Month[] {
  if (rows.length === 0) return [];
  const counts = new Map(rows.map((r) => [r.month, r.count]));
  const out: Month[] = [];
  let [y, m] = rows[0]!.month.split('-').map(Number) as [number, number];
  const last = rows.at(-1)!.month;
  for (let guard = 0; guard < 600; guard++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    out.push({ month: key, count: counts.get(key) ?? 0 });
    if (key === last) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}
