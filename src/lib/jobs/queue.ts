import { env } from 'cloudflare:workers';
import type { MbTarget } from '../musicbrainz/input';

export type JobKind =
  | 'import_release'
  | 'import_discography'
  | 'derive_genres'
  | 'backup'
  | 'recompute_calibration'
  | 'spotify_push'
  | 'generate_art';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface JobPayloads {
  import_release:
    | {
        source: 'musicbrainz';
        target: MbTarget;
        /** What it is, when known at queueing ("Under Pressure"): the jobs page shows it until the import lands. */
        label?: string;
        /** Local files to catalogue against the release once written (import from tags). */
        files?: import('../import/files').FileAttachment[];
        /** timing: each stage in ms (plan, write, twins, art, musicbrainz, others), to see where imports spend their time. */
        result?: { releaseGroupId: string; filesAttached?: number; timing?: Record<string, number> };
      }
    | {
        source: 'spotify';
        target: import('../spotify/album').SpotifyTarget;
        label?: string;
        result?: { releaseGroupId: string; via: 'musicbrainz' | 'spotify' };
      };
  spotify_push: { definitionId: string; result?: import('../spotify/push').PushReport };
  backup: { result?: import('../backup/store').BackupReport };
}

/** The newest job of a kind. */
export async function latestJob(kind: JobKind): Promise<JobRow | null> {
  return env.DB.prepare('SELECT * FROM job WHERE kind = ? ORDER BY created_at DESC LIMIT 1')
    .bind(kind)
    .first<JobRow>();
}

export interface JobRow {
  id: string;
  kind: JobKind;
  payload_json: string;
  status: JobStatus;
  progress: number;
  total: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  attempts: number;
  /** 1 asked for directly (goes first), 0 bulk: PRIORITY, 0071. */
  priority: number;
  /** The import or refresh that queued it (0072); none for single imports, backups, pushes. */
  batch_id: string | null;
}

/** A job left 'running' this long belongs to an invocation that died. */
const STALE_AFTER_MINUTES = 6;
/** Starts a job gets before, cut off on each, it is failed (0064). */
const MAX_ATTEMPTS = 3;

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

/**
 * Which lane a job waits in (0071): what Cillian asked for directly (a
 * refresh, one import, a push) goes ahead of bulk work (whole
 * discographies, the whole library refreshed), however long that is.
 */
export const PRIORITY = { asked: 1, bulk: 0 } as const;
export type Priority = (typeof PRIORITY)[keyof typeof PRIORITY];

/** One job, asked for directly unless said otherwise, in a batch if given. */
export async function enqueue<K extends keyof JobPayloads>(
  kind: K,
  payload: JobPayloads[K],
  priority: Priority = PRIORITY.asked,
  batchId: string | null = null,
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO job (id, kind, payload_json, priority, batch_id) VALUES (?, ?, ?, ?, ?)')
    .bind(id, kind, JSON.stringify(payload), priority, batchId)
    .run();
  return id;
}

/**
 * Queues many jobs of one kind in a few round trips (a whole discography
 * is hundreds), as bulk work unless said otherwise. Jobs inserted in the
 * same instant still run in the order given: the claim breaks created_at
 * ties by rowid.
 */
export async function enqueueMany<K extends keyof JobPayloads>(
  kind: K,
  payloads: JobPayloads[K][],
  priority: Priority = PRIORITY.bulk,
  batchId: string | null = null,
): Promise<string[]> {
  const ids = payloads.map(() => crypto.randomUUID());
  const statement = env.DB.prepare('INSERT INTO job (id, kind, payload_json, priority, batch_id) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < ids.length; i += 100) {
    await env.DB.batch(ids.slice(i, i + 100).map((id, n) => statement.bind(id, kind, JSON.stringify(payloads[i + n]), priority, batchId)));
  }
  return ids;
}

export type BatchKind = 'discography' | 'refresh' | 'library' | 'files' | 'other';

export interface BatchRow {
  id: string;
  label: string;
  kind: BatchKind;
  href: string | null;
  created_at: string;
  queued: number;
  running: number;
  done: number;
  failed: number;
}

/** A named batch for the jobs an import or refresh is about to queue (0072). */
export async function createBatch(label: string, kind: BatchKind, href: string | null = null): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO job_batch (id, label, kind, href) VALUES (?, ?, ?, ?)').bind(id, label, kind, href).run();
  return id;
}

export async function renameBatch(id: string, label: string): Promise<void> {
  await env.DB.prepare('UPDATE job_batch SET label = ? WHERE id = ?').bind(label, id).run();
}

/** A batch with nothing in it (everything was already here): not worth a card. */
export async function deleteBatch(id: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM job_batch WHERE id = ? AND NOT EXISTS (SELECT 1 FROM job WHERE batch_id = ?1)`).bind(id).run();
}

/**
 * Batches for the Jobs page: every one with work left, and the most
 * recently started of the finished. Counts are kept on each (0072), so
 * this reads a row a batch; which ones are going first is a seek of the
 * priority lane.
 */
export async function jobBatches(finished = 8): Promise<(BatchRow & { first: boolean })[]> {
  const [active, ended, first] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM job_batch WHERE queued + running > 0 ORDER BY created_at`),
    env.DB.prepare(`SELECT * FROM job_batch WHERE queued + running = 0 ORDER BY created_at DESC LIMIT ?`).bind(finished),
    env.DB.prepare(`SELECT DISTINCT batch_id FROM job WHERE status = 'queued' AND priority > 0 AND batch_id IS NOT NULL`),
  ]);
  const going = new Set((first!.results as { batch_id: string }[]).map((r) => r.batch_id));
  return [...(active!.results as BatchRow[]), ...(ended!.results as BatchRow[])].map((b) => ({ ...b, first: going.has(b.id) }));
}

/** Jobs in no batch (single imports, backups, pushes, older imports), newest first: by the job_loose index. */
export async function looseJobs(limit = 40): Promise<JobRow[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM job WHERE batch_id IS NULL ORDER BY created_at DESC LIMIT ?`).bind(limit).all<JobRow>();
  return results;
}

/** Every failed job, newest first (by job_queue). */
export async function failedJobs(limit = 100): Promise<JobRow[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM job WHERE status = 'failed' ORDER BY finished_at DESC LIMIT ?`).bind(limit).all<JobRow>();
  return results;
}

export async function jobBatch(id: string): Promise<BatchRow | null> {
  return env.DB.prepare('SELECT * FROM job_batch WHERE id = ?').bind(id).first<BatchRow>();
}

/** A batch's jobs: failed, then running, then waiting in the order they will run, then done. */
export async function batchJobs(batchId: string, limit = 400): Promise<JobRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM job WHERE batch_id = ?
     ORDER BY CASE status WHEN 'failed' THEN 0 WHEN 'running' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END,
              priority DESC, created_at, rowid
     LIMIT ?`,
  )
    .bind(batchId, limit)
    .all<JobRow>();
  return results;
}

/** Everything still waiting in a batch to the front (in its order), or back in line. Returns how many moved. */
export async function prioritiseBatch(batchId: string, first: boolean): Promise<number> {
  const result = await env.DB.prepare(
    first
      ? `UPDATE job SET priority = ${PRIORITY.asked}, created_at = ${NOW} WHERE batch_id = ? AND status = 'queued' AND priority < ${PRIORITY.asked}`
      : `UPDATE job SET priority = ${PRIORITY.bulk} WHERE batch_id = ? AND status = 'queued' AND priority > ${PRIORITY.bulk}`,
  )
    .bind(batchId)
    .run();
  return result.meta.changes ?? 0;
}

/** Takes everything still waiting in a batch out of the queue. Returns how many. */
export async function removeBatchQueued(batchId: string): Promise<number> {
  const result = await env.DB.prepare(`DELETE FROM job WHERE batch_id = ? AND status = 'queued'`).bind(batchId).run();
  return result.meta.changes ?? 0;
}

/**
 * Atomically takes the oldest runnable job. Safe when the cron and an
 * on-demand run overlap: the UPDATE only succeeds for one of them.
 */
export async function claimNext(): Promise<JobRow | null> {
  const stuck = `status = 'running' AND started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${STALE_AFTER_MINUTES} minutes')`;
  const [, , claimed] = await env.DB.batch<JobRow>([
    // Cut off on each of its tries: it would only be cut off again.
    env.DB.prepare(
      `UPDATE job SET status = 'failed', finished_at = ${NOW},
              error = 'Stopped after ${MAX_ATTEMPTS} tries: each time, the Worker running it was cut off before it finished (out of memory or time).'
       WHERE ${stuck} AND attempts >= ${MAX_ATTEMPTS}`,
    ),
    // Cut off, with tries left: to the back of the queue, not the front.
    env.DB.prepare(`UPDATE job SET status = 'queued', started_at = NULL, created_at = ${NOW} WHERE ${stuck}`),
    env.DB.prepare(
    `UPDATE job
     SET status = 'running', started_at = ${NOW}, error = NULL, attempts = attempts + 1
     WHERE id = (
       -- What was asked for first, then the oldest: one seek of
       -- job_queue (status, priority DESC, created_at), 0071.
       SELECT id FROM job
       WHERE status = 'queued'
         -- Nothing starts while the queue is paused; what is running finishes.
         AND NOT EXISTS (SELECT 1 FROM app_setting WHERE key = 'jobs_paused' AND value = '1')
       ORDER BY priority DESC, created_at, rowid
       LIMIT 1
     )
     RETURNING *`,
    ),
  ]);
  return claimed?.results[0] ?? null;
}

export async function complete(id: string, payload: unknown, progress = 1): Promise<void> {
  await env.DB.prepare(
    `UPDATE job
     SET status = 'done', finished_at = ${NOW}, payload_json = ?, progress = ?, total = coalesce(total, ?)
     WHERE id = ?`,
  )
    .bind(JSON.stringify(payload), progress, progress, id)
    .run();
}

export async function fail(id: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await env.DB.prepare(
    `UPDATE job SET status = 'failed', finished_at = ${NOW}, error = ? WHERE id = ?`,
  )
    .bind(message.slice(0, 2000), id)
    .run();
}

/**
 * Back to queued, keeping its place: the queue goes by created_at, so a job
 * that was running when it had to stop is the next one claimed.
 */
export async function requeue(id: string): Promise<void> {
  await env.DB.prepare(`UPDATE job SET status = 'queued', started_at = NULL, error = NULL, attempts = 0 WHERE id = ?`).bind(id).run();
}

/**
 * To the back of the queue, its attempts kept: a job that stalled (too
 * slow, refused by MusicBrainz, its Worker cut off) waits behind everything
 * else rather than holding the queue up. One that stalls every time still
 * fails in the end (runner.ts, MAX_TRIES).
 */
export async function toBack(id: string): Promise<void> {
  await env.DB.prepare(`UPDATE job SET status = 'queued', started_at = NULL, error = NULL, created_at = ${NOW} WHERE id = ?`).bind(id).run();
}

/** Puts a failed job back in the queue. Partial work is kept: imports are idempotent. */
/** Every failed job back in the queue. Returns how many. */
export async function retryAllFailed(): Promise<number> {
  const result = await env.DB.prepare(
    `UPDATE job SET status = 'queued', error = NULL, started_at = NULL, finished_at = NULL, attempts = 0 WHERE status = 'failed'`,
  ).run();
  return result.meta.changes ?? 0;
}

export async function retry(id: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE job
     SET status = 'queued', error = NULL, started_at = NULL, finished_at = NULL
     WHERE id = ? AND status = 'failed'`,
  )
    .bind(id)
    .run();
  return result.meta.changes > 0;
}

/** The newest spotify_push job for a definition, finished or not. */
export async function latestPush(definitionId: string): Promise<JobRow | null> {
  return env.DB.prepare(
    `SELECT * FROM job
     WHERE kind = 'spotify_push' AND json_extract(payload_json, '$.definitionId') = ?
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(definitionId)
    .first<JobRow>();
}

export async function recentJobs(limit = 50): Promise<JobRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM job ORDER BY created_at DESC LIMIT ?')
    .bind(limit)
    .all<JobRow>();
  return results;
}

/**
 * How many jobs are in each state, across the whole queue (not just the
 * recent page): kept in app_setting by triggers (0070), four rows a read.
 */
export async function jobCounts(): Promise<Record<JobStatus, number>> {
  const { results } = await env.DB.prepare(
    `SELECT substr(key, 8) AS status, CAST(value AS INTEGER) AS n FROM app_setting
     WHERE key IN ('jobs_n_queued', 'jobs_n_running', 'jobs_n_done', 'jobs_n_failed')`,
  ).all<{ status: JobStatus; n: number }>();
  const counts: Record<JobStatus, number> = { queued: 0, running: 0, done: 0, failed: 0 };
  for (const r of results) counts[r.status] = Math.max(0, r.n);
  return counts;
}

/** Sets the kept counts from a real count: nightly, in case a restore moved the table under them. */
export async function recountJobs(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_setting (key, value)
     SELECT 'jobs_n_' || s.status, CAST((SELECT count(*) FROM job j WHERE j.status = s.status) AS TEXT)
     FROM (SELECT 'queued' AS status UNION ALL SELECT 'running' UNION ALL SELECT 'done' UNION ALL SELECT 'failed') s
     WHERE true
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run();
  // Each batch's too (0072), by the job_batch_member index.
  await env.DB.prepare(
    `UPDATE job_batch SET
       queued = (SELECT count(*) FROM job WHERE batch_id = job_batch.id AND status = 'queued'),
       running = (SELECT count(*) FROM job WHERE batch_id = job_batch.id AND status = 'running'),
       done = (SELECT count(*) FROM job WHERE batch_id = job_batch.id AND status = 'done'),
       failed = (SELECT count(*) FROM job WHERE batch_id = job_batch.id AND status = 'failed')`,
  ).run();
}

export interface QueueProgress {
  counts: Record<JobStatus, number>;
  /** Jobs finished an hour at the recent pace; null with too few to tell. */
  perHour: number | null;
  /** What is being worked on now, by its label. */
  current: string | null;
  /** Waiting in the priority lane (asked for directly), ahead of the bulk. */
  first: number;
}

/** How many finished jobs the pace is taken over. */
const PACE_SAMPLE = 20;

/**
 * The whole queue in a glance, for the import tray on any device: a few
 * dozen rows a read (kept counts, the last finished jobs by the
 * finished_at index, the running job by the status index).
 */
export async function queueProgress(): Promise<QueueProgress> {
  const [counts, recent, running, first] = await Promise.all([
    jobCounts(),
    env.DB.prepare(`SELECT finished_at FROM job WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT ?`)
      .bind(PACE_SAMPLE)
      .all<{ finished_at: string }>(),
    env.DB.prepare(`SELECT payload_json FROM job WHERE status = 'running' ORDER BY created_at LIMIT 1`).first<{ payload_json: string }>(),
    // Only the priority lane's rows, by job_queue.
    env.DB.prepare(`SELECT count(*) AS n FROM job WHERE status = 'queued' AND priority > 0`).first<number>('n'),
  ]);
  return { counts, perHour: pace(recent.results.map((r) => r.finished_at), Date.now()), current: labelOf(running?.payload_json), first: first ?? 0 };
}

/**
 * Jobs an hour from the newest finish times. Only a pace still going: if
 * the last finish was long ago (paused, or a batch that ended), there is
 * no pace to speak of.
 */
export function pace(finishedNewestFirst: string[], now: number): number | null {
  const times = finishedNewestFirst.map((t) => Date.parse(t)).filter(Number.isFinite);
  if (times.length < 3) return null;
  const newest = times[0]!;
  const oldest = times[times.length - 1]!;
  const span = newest - oldest;
  if (span <= 0 || now - newest > 15 * 60_000) return null;
  return ((times.length - 1) / span) * 3_600_000;
}

function labelOf(payloadJson: string | undefined): string | null {
  if (!payloadJson) return null;
  try {
    const label = (JSON.parse(payloadJson) as { label?: unknown }).label;
    return typeof label === 'string' && label ? label : null;
  } catch {
    return null;
  }
}

/** Whether the queue is paused: waiting jobs stay waiting until resumed. */
export async function queuePaused(): Promise<boolean> {
  return Boolean(await env.DB.prepare(`SELECT 1 AS yes FROM app_setting WHERE key = 'jobs_paused' AND value = '1'`).first());
}

export async function setQueuePaused(paused: boolean): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_setting (key, value) VALUES ('jobs_paused', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  )
    .bind(paused ? '1' : '0')
    .run();
}

/**
 * Moves waiting jobs to the front: into the priority lane, at its back,
 * so what was put first earlier still goes before them. Returns how many moved.
 */
export async function promote(ids: string[], batchId: string | null = null): Promise<number> {
  if (ids.length === 0) return 0;
  // Into the batch that asked for them, when one did (they count there now).
  const result = await env.DB.prepare(
    `UPDATE job SET priority = ${PRIORITY.asked}, created_at = ${NOW}, batch_id = coalesce(?2, batch_id)
     WHERE status = 'queued' AND (priority < ${PRIORITY.asked} OR ?2 IS NOT NULL) AND id IN (SELECT value FROM json_each(?1))`,
  )
    .bind(JSON.stringify(ids), batchId)
    .run();
  return result.meta.changes ?? 0;
}

/** Takes a job out of the queue before it starts. Returns whether it was still waiting. */
export async function removeQueued(id: string): Promise<boolean> {
  const result = await env.DB.prepare(`DELETE FROM job WHERE id = ? AND status = 'queued'`).bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}
