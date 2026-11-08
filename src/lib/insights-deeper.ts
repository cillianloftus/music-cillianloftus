/**
 * The deeper cuts on the Insights page: what the ratings say about song
 * length, where a track sits on its album, guest features, the artist's age
 * when they made it, and which part of a song is rated highest. All read
 * from the score views and ratings; nothing stored. Groups with fewer than
 * two tracks are kept out of the "favourite" lines, so one song is never a
 * pattern.
 */

import { env } from 'cloudflare:workers';

export interface Band {
  key: string;
  label: string;
  average: number;
  count: number;
}

export interface Deeper {
  length: Band[];
  position: Band[];
  features: Band[];
  age: Band[];
  /** Average at each exact age, youngest first. */
  ageByYear: Band[];
  /** Across every track: does the score move with the artist's age? */
  ageLink: { r: number; tracks: number; artists: number } | null;
  axes: Band[];
}

/** Pearson's r between two equal-length lists, or null when it cannot be told. */
export function correlation(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

/** The band with the best average among those with at least two tracks. */
export function favourite(bands: Band[]): Band | null {
  return bands.filter((b) => b.count >= 2).sort((a, b) => b.average - a.average || b.count - a.count)[0] ?? null;
}

export async function deeperInsights(userId: string): Promise<Deeper> {
  const [length, position, features, age, axes] = await env.DB.batch([
    // Song length, in bands that read naturally.
    env.DB.prepare(
      `SELECT CASE
                WHEN r.length_ms < 120000 THEN '0'
                WHEN r.length_ms < 180000 THEN '1'
                WHEN r.length_ms < 240000 THEN '2'
                WHEN r.length_ms < 300000 THEN '3'
                WHEN r.length_ms < 360000 THEN '4'
                ELSE '5' END AS key,
              avg(s.quality_score) AS average, count(*) AS count
       FROM v_recording_score s JOIN recording r ON r.id = s.recording_id
       WHERE s.user_id = ? AND r.length_ms IS NOT NULL
       GROUP BY key ORDER BY key`,
    ).bind(userId),
    // Where it sits on its album's standard edition: opener, closer, or between.
    env.DB.prepare(
      `WITH placed AS (
         SELECT s.recording_id, s.quality_score, t.position,
                (SELECT count(*) FROM track t2 WHERE t2.release_id = t.release_id) AS size
         FROM v_recording_score s
         JOIN v_recording_album ra ON ra.recording_id = s.recording_id
         JOIN v_release_group_canonical c ON c.release_group_id = ra.release_group_id
         JOIN track t ON t.release_id = c.release_id AND t.recording_id = s.recording_id
         WHERE s.user_id = ?
       )
       SELECT CASE
                WHEN size < 3 THEN NULL
                WHEN position = 1 THEN '0'
                WHEN position = size THEN '3'
                WHEN position * 2 <= size THEN '1'
                ELSE '2' END AS key,
              avg(quality_score) AS average, count(*) AS count
       FROM placed WHERE size >= 3
       GROUP BY key ORDER BY key`,
    ).bind(userId),
    // Solo, or with a guest.
    env.DB.prepare(
      `SELECT CASE WHEN EXISTS (SELECT 1 FROM artist_credit c WHERE c.entity_type = 'recording' AND c.entity_id = s.recording_id AND c.role = 'featured')
                     OR (SELECT count(*) FROM artist_credit c WHERE c.entity_type = 'recording' AND c.entity_id = s.recording_id AND c.role = 'primary') > 1
                   THEN '1' ELSE '0' END AS key,
              avg(s.quality_score) AS average, count(*) AS count
       FROM v_recording_score s WHERE s.user_id = ?
       GROUP BY key ORDER BY key`,
    ).bind(userId),
    // The lead artist's age when it came out, for people with a known birth year.
    env.DB.prepare(
      `WITH aged AS (
         SELECT s.quality_score, a.id AS artist_id,
                CAST(substr(coalesce(r.first_release_date, g.first_release_date), 1, 4) AS INTEGER) - CAST(substr(a.begin_date, 1, 4) AS INTEGER) AS age
         FROM v_recording_score s
         JOIN recording r ON r.id = s.recording_id
         LEFT JOIN v_recording_album ra ON ra.recording_id = r.id
         LEFT JOIN release_group g ON g.id = ra.release_group_id
         JOIN artist_credit c ON c.entity_type = 'recording' AND c.entity_id = r.id AND c.role = 'primary' AND c.position = 1
         JOIN artist a ON a.id = c.artist_id
         WHERE s.user_id = ? AND a.kind = 'person' AND a.begin_date IS NOT NULL
           AND coalesce(r.first_release_date, g.first_release_date) IS NOT NULL
       )
       SELECT age, quality_score, artist_id FROM aged WHERE age BETWEEN 10 AND 100`,
    ).bind(userId),
    // Each axis, from every track's latest considered rating.
    env.DB.prepare(
      `WITH latest AS (
         SELECT x.* FROM rating x
         WHERE x.user_id = ?1 AND x.entity_type = 'recording'
           AND x.rated_at = (SELECT max(y.rated_at) FROM rating y WHERE y.user_id = x.user_id AND y.entity_type = 'recording' AND y.entity_id = x.entity_id)
       )
       SELECT 'arrangement' AS key, avg(coalesce(arrangement, production)) * 10 AS average, count(coalesce(arrangement, production)) AS count FROM latest
       UNION ALL SELECT 'sound', avg(coalesce(sound, production)) * 10, count(coalesce(sound, production)) FROM latest
       UNION ALL SELECT 'songwriting', avg(songwriting) * 10, count(songwriting) FROM latest
       UNION ALL SELECT 'lyrics', avg(lyrics) * 10, count(lyrics) FROM latest
       UNION ALL SELECT 'performance', avg(performance) * 10, count(performance) FROM latest`,
    ).bind(userId),
  ]);

  const LABELS: Record<string, Record<string, string>> = {
    length: { '0': 'Under 2 min', '1': '2–3 min', '2': '3–4 min', '3': '4–5 min', '4': '5–6 min', '5': '6 min +' },
    position: { '0': 'Opener', '1': 'First half', '2': 'Second half', '3': 'Closer' },
    features: { '0': 'Solo', '1': 'With a guest' },
    age: { '0': 'Under 20', '1': '20–24', '2': '25–29', '3': '30s', '4': '40 +' },
    axes: { arrangement: 'Arrangement', sound: 'Sound', songwriting: 'Songwriting', lyrics: 'Lyrics', performance: 'Performance' },
  };
  const bands = (result: D1Result | undefined, kind: keyof typeof LABELS) =>
    ((result?.results ?? []) as { key: string | null; average: number | null; count: number }[])
      .filter((r) => r.key !== null && r.average !== null && r.count > 0)
      .map((r) => ({ key: r.key!, label: LABELS[kind]![r.key!] ?? r.key!, average: r.average!, count: r.count }));

  // Age: one row per track, so both the bands and the correlation come from it.
  const aged = (age?.results ?? []) as { age: number; quality_score: number; artist_id: string }[];
  const groupBy = (keyOf: (r: (typeof aged)[number]) => string, labelOf: (k: string) => string) => {
    const m = new Map<string, number[]>();
    for (const r of aged) m.set(keyOf(r), [...(m.get(keyOf(r)) ?? []), r.quality_score]);
    return [...m]
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([k, scores]) => ({ key: k, label: labelOf(k), average: scores.reduce((x, y) => x + y, 0) / scores.length, count: scores.length }));
  };
  const bandOf = (a: number) => (a < 20 ? '0' : a < 25 ? '1' : a < 30 ? '2' : a < 40 ? '3' : '4');
  const r = correlation(aged.map((x) => x.age), aged.map((x) => x.quality_score));

  return {
    length: bands(length, 'length'),
    position: bands(position, 'position'),
    features: bands(features, 'features'),
    age: groupBy((x) => bandOf(x.age), (k) => LABELS.age![k] ?? k),
    ageByYear: groupBy((x) => String(x.age), (k) => k),
    ageLink: r === null ? null : { r, tracks: aged.length, artists: new Set(aged.map((x) => x.artist_id)).size },
    axes: bands(axes, 'axes'),
  };
}
