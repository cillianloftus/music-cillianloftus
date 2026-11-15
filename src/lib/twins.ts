/**
 * Twins: two records of one recording. A single's copy of a song and its
 * album's are often separate MusicBrainz recordings (the next ISRC along,
 * the same length to a tenth of a second), so a rating on one never showed
 * on the other ("Overnight" on Logic's single, rated on Bobby Tarantino II).
 * Linked as versions of one song (one work), the duplicate check never
 * asked about them. Same work, same title, lengths within 2 s, and not
 * judged different: they are merged, keeping whichever holds more
 * (merge.ts, survivor), so ratings, plays and pins are on one song.
 *
 * After each import, for its own songs; and through the rest of the
 * library a batch at a time on the cron (10,700 pairs on 15 Nov).
 */

import { env } from 'cloudflare:workers';
import { mergeRecordings, survivor } from './merge';

/** Lengths this close are one recording's. */
const SAME_LENGTH_MS = 2000;

const TWINS = `
  FROM recording a
  JOIN recording b ON b.work_id = a.work_id AND b.id <> a.id AND lower(b.title) = lower(a.title)
   AND abs(a.length_ms - b.length_ms) <= ${SAME_LENGTH_MS}
  WHERE a.work_id IS NOT NULL AND a.length_ms IS NOT NULL AND b.length_ms IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM confirmed_distinct d WHERE d.entity_type = 'recording'
                    AND d.id_a = min(a.id, b.id) AND d.id_b = max(a.id, b.id))`;

/** Twin pairs: of the given songs (an import's), or anywhere, a batch at a time. */
export async function findTwins(of: string[] | null, limit = 200): Promise<[string, string][]> {
  const { results } = of
    ? await env.DB.prepare(`SELECT a.id AS a, b.id AS b ${TWINS} AND a.id IN (SELECT value FROM json_each(?1)) LIMIT ?2`)
        .bind(JSON.stringify(of), limit)
        .all<{ a: string; b: string }>()
    : await env.DB.prepare(`SELECT a.id AS a, b.id AS b ${TWINS} AND a.id < b.id LIMIT ?1`)
        .bind(limit)
        .all<{ a: string; b: string }>();
  return results.map((r) => [r.a, r.b]);
}

/**
 * Merges twins until none are left or the time is spent: of some songs
 * when given (straight after their import), else the library's. Returns
 * how many were merged. One run at a time (a lease in app_setting), so two
 * cron ticks never merge the same pair.
 */
export async function mergeTwins({ budgetMs, of = null }: { budgetMs: number; of?: string[] | null }): Promise<number> {
  const stop = Date.now() + budgetMs;
  if (!of && !(await takeLease(budgetMs + 30_000))) return 0;
  let merged = 0;
  try {
    while (Date.now() < stop) {
      const pairs = await findTwins(of);
      if (pairs.length === 0) break;
      // Each song once a batch: a merged-away song cannot be merged again.
      const gone = new Set<string>();
      let progress = 0;
      for (const [a, b] of pairs) {
        if (Date.now() >= stop) break;
        if (gone.has(a) || gone.has(b)) continue;
        try {
          const [keep, lose] = await survivor('recording', a, b);
          await mergeRecordings(keep, lose);
          gone.add(lose);
          merged++;
          progress++;
        } catch (error) {
          console.warn('Twin merge failed', a, b, error);
        }
      }
      if (progress === 0) break;
    }
  } finally {
    if (!of) await env.DB.prepare(`UPDATE app_setting SET value = '' WHERE key = 'twins_lease'`).run();
  }
  return merged;
}

async function takeLease(forMs: number): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO app_setting (key, value) VALUES ('twins_lease', ?1)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE app_setting.value < ?2`,
  )
    .bind(new Date(Date.now() + forMs).toISOString(), now)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
