/**
 * How widely each track is heard, from ListenBrainz (migration 0054): kept
 * on the recording and looked at again each month. A hundred tracks to a
 * request, by MusicBrainz id; tracks without one are not asked about.
 */

import { env } from 'cloudflare:workers';
import { recordingPopularity } from './sources/listenbrainz';

const BATCH = 100;

export async function fillPopularity({
  budgetMs,
  batches = 20,
  fetcher = fetch,
}: {
  budgetMs: number;
  batches?: number;
  fetcher?: typeof fetch;
}): Promise<{ looked: number; found: number; left: number }> {
  const deadline = Date.now() + budgetMs;
  const waiting = `FROM recording r
     WHERE r.mbid IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM lookup_log l WHERE l.source = 'listenbrainz' AND l.entity_id = r.id AND l.looked_at > datetime('now', '-30 days'))`;
  const report = { looked: 0, found: 0, left: 0 };
  for (let i = 0; i < batches && Date.now() < deadline; i++) {
    const { results } = await env.DB.prepare(`SELECT r.id, r.mbid ${waiting} LIMIT ?`).bind(BATCH).all<{ id: string; mbid: string }>();
    if (results.length === 0) break;
    const known = new Map((await recordingPopularity(results.map((r) => r.mbid), fetcher)).map((p) => [p.mbid, p]));
    const statements: D1PreparedStatement[] = [];
    for (const r of results) {
      const p = known.get(r.mbid);
      const found = p?.listens != null;
      if (found) {
        report.found += 1;
        statements.push(env.DB.prepare(`UPDATE recording SET listen_count = ?2, listener_count = ?3 WHERE id = ?1`).bind(r.id, p.listens, p.listeners));
      }
      statements.push(
        env.DB.prepare(
          `INSERT INTO lookup_log (source, entity_id, found) VALUES ('listenbrainz', ?, ?)
           ON CONFLICT (source, entity_id) DO UPDATE SET found = excluded.found, looked_at = excluded.looked_at`,
        ).bind(r.id, found ? 1 : 0),
      );
    }
    await env.DB.batch(statements);
    report.looked += results.length;
  }
  report.left = (await env.DB.prepare(`SELECT count(*) AS n ${waiting}`).first<{ n: number }>())?.n ?? 0;
  return report;
}
