import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { kickJobs } from '../../../../lib/jobs/runner';
import { queuePaused, queueProgress } from '../../../../lib/jobs/queue';

/**
 * Where some jobs have got to, for the import tray: status, the error if
 * one failed, and the album once one has landed. GET ?id=…&id=…
 */
export const GET: APIRoute = async ({ url, locals }) => answer(url.searchParams.getAll('id'), locals);

/** The same, with the ids as a JSON array: a big batch outgrows a URL. */
export const POST: APIRoute = async ({ request, locals }) => {
  const body = (await request.json().catch(() => ({}))) as { ids?: unknown };
  return answer(Array.isArray(body.ids) ? body.ids.map(String) : [], locals);
};

async function answer(all: string[], locals: App.Locals): Promise<Response> {
  const ids = all.slice(0, 100);
  // The whole queue too, so the tray shows a batch queued on another
  // device or in an earlier visit (a few dozen rows: queueProgress).
  const queue = await queueProgress();
  if (ids.length === 0) {
    const paused = await queuePaused();
    if (!paused && queue.counts.queued > 0 && queue.counts.running === 0) kickJobs(locals.cfContext);
    return Response.json({ jobs: [], paused, queue }, { headers: { 'cache-control': 'no-store' } });
  }
  const { results } = await env.DB.prepare(
    `SELECT j.id, j.status, j.error, g.id AS album_id, g.title AS album_title
     FROM job j
     LEFT JOIN release_group g ON g.id = json_extract(j.payload_json, '$.result.releaseGroupId')
     WHERE j.id IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(ids))
    .all<{ id: string; status: string; error: string | null; album_id: string | null; album_title: string | null }>();
  // Someone is watching jobs wait: if nothing is working the queue, start
  // a run. The cron does this every minute in production, but a long batch
  // should not sit idle between ticks, and local dev has no cron at all.
  // Claiming is atomic, so a run started here and one from the cron never
  // take the same job.
  const paused = Boolean(await env.DB.prepare(`SELECT 1 AS yes FROM app_setting WHERE key = 'jobs_paused' AND value = '1'`).first());
  if (!paused && results.some((j) => j.status === 'queued')) {
    const running = await env.DB.prepare(
      `SELECT 1 AS yes FROM job WHERE status = 'running' AND started_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 minutes')`,
    ).first();
    if (!running) kickJobs(locals.cfContext);
  }
  return Response.json({ jobs: results, paused, queue }, { headers: { 'cache-control': 'no-store' } });
}
