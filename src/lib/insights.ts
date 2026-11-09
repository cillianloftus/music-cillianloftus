/**
 * What the ratings say about the person making them: how scores spread,
 * which decades and genre families score highest, how gut and considered
 * judgement differ, how often impact is given, and when the rating
 * happened. All from the score views; nothing stored.
 */

import { env } from 'cloudflare:workers';
import { albumScores, type ScoredAlbum } from './album-scores';
import { genreIndex } from './genres';

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
  const [batch, scores, index] = await Promise.all([env.DB.batch([
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
    // Genre families: from the genre index and the tree, in code (genreFamilies).
    env.DB.prepare(`SELECT id, name, parent_id FROM genre`),
    env.DB.prepare(`SELECT recording_id AS id, quality_score AS score FROM v_recording_score WHERE user_id = ?`).bind(userId),
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
  ]), albumScores(userId), genreIndex()]);
  const [headline, spread, genres, scored, months, artists, years] = batch;

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
    families: genreFamilies(
      index.tracks,
      genres!.results as { id: string; name: string; parent_id: string | null }[],
      scored!.results as { id: string; score: number }[],
    ),
    months: fillMonths(months!.results as Month[]),
    artists: artists!.results as ArtistRow[],
  };
}

/**
 * Average track score by genre family: each rated track counted once under
 * every root (top-level genre, through primary parents) its genres lead
 * to; families with two or more tracks, best first, twelve at most. From
 * the genre index, where walking the tag rows in SQL read 135,000 rows.
 * Pure.
 */
export function genreFamilies(
  members: Record<string, string[]>,
  genres: { id: string; name: string; parent_id: string | null }[],
  scored: { id: string; score: number }[],
): Group[] {
  const byId = new Map(genres.map((g) => [g.id, g]));
  const rootOf = (id: string): string | null => {
    const seen = new Set<string>();
    let g = byId.get(id);
    while (g?.parent_id && !seen.has(g.id)) {
      seen.add(g.id);
      g = byId.get(g.parent_id);
    }
    return g?.id ?? null;
  };
  const scoreOf = new Map(scored.map((s) => [s.id, s.score]));
  const rootsOf = new Map<string, Set<string>>();
  for (const [genre, ids] of Object.entries(members)) {
    const root = rootOf(genre);
    if (!root) continue;
    for (const id of ids) {
      if (!scoreOf.has(id)) continue;
      (rootsOf.get(id) ?? rootsOf.set(id, new Set()).get(id)!).add(root);
    }
  }
  const tally = new Map<string, { total: number; count: number }>();
  for (const [id, roots] of rootsOf) {
    for (const root of roots) {
      const t = tally.get(root) ?? { total: 0, count: 0 };
      t.total += scoreOf.get(id)!;
      t.count += 1;
      tally.set(root, t);
    }
  }
  return [...tally]
    .filter(([, t]) => t.count >= 2)
    .map(([root, t]) => ({ key: byId.get(root)!.name, label: byId.get(root)!.name, average: t.total / t.count, count: t.count }))
    .sort((a, b) => b.average - a.average || b.count - a.count)
    .slice(0, 12);
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
