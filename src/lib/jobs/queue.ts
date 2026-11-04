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
        /** Local files to catalogue against the release once written (import from tags). */
        files?: import('../import/files').FileAttachment[];
        result?: { releaseGroupId: string; filesAttached?: number };
      }
    | {
        source: 'spotify';
        target: import('../spotify/album').SpotifyTarget;
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
}

/** A job left 'running' this long belongs to an invocation that died. */
const STALE_AFTER_MINUTES = 15;

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

export async function enqueue<K extends keyof JobPayloads>(kind: K, payload: JobPayloads[K]): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO job (id, kind, payload_json) VALUES (?, ?, ?)')
    .bind(id, kind, JSON.stringify(payload))
    .run();
  return id;
}

/**
 * Atomically takes the oldest runnable job. Safe when the cron and an
 * on-demand run overlap: the UPDATE only succeeds for one of them.
 */
export async function claimNext(): Promise<JobRow | null> {
  return env.DB.prepare(
    `UPDATE job
     SET status = 'running', started_at = ${NOW}, error = NULL
     WHERE id = (
       SELECT id FROM job
       WHERE status = 'queued'
          OR (status = 'running'
              AND started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${STALE_AFTER_MINUTES} minutes'))
       ORDER BY created_at
       LIMIT 1
     )
     RETURNING *`,
  ).first<JobRow>();
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

/** Puts a failed job back in the queue. Partial work is kept: imports are idempotent. */
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
