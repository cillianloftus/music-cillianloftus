/**
 * How the site itself is doing, for /manage/health: the newest backup,
 * the day's D1 reads, the job queue, and how each nightly task went.
 * Built after the backup failed silently for two days (10-11 Nov 2026):
 * every check here is one that would have shown it.
 */

import { env } from 'cloudflare:workers';
import { listBackups } from './backup/store';

/** A backup older than this is overdue: one is made at 04:00 UTC each day. */
export const BACKUP_DUE_HOURS = 30;
/** The day's D1 reads the site aims to stay under (D1's free allowance). */
export const READ_BUDGET = 5_000_000;

export interface BackupState {
  key: string;
  at: string;
  rows: number | null;
  bytes: number;
  overdue: boolean;
}

export async function latestBackup(now = Date.now()): Promise<BackupState | null> {
  const [newest] = await listBackups();
  if (!newest) return null;
  const at = newest.customMetadata?.created_at ?? newest.uploaded.toISOString();
  return {
    key: newest.key,
    at,
    rows: newest.customMetadata?.rows ? Number(newest.customMetadata.rows) : null,
    bytes: newest.size,
    overdue: now - new Date(at).getTime() > BACKUP_DUE_HOURS * 3_600_000,
  };
}

// Nightly tasks: each run's outcome, kept in KV (one write a night).

export interface TaskRun {
  name: string;
  at: string;
  ok: boolean;
  ms: number;
  error?: string;
}

const TASKS_KEY = 'health:nightly';

export async function recordNightly(runs: TaskRun[]): Promise<void> {
  await env.CACHE.put(TASKS_KEY, JSON.stringify(runs), { expirationTtl: 14 * 86_400 });
}

export async function nightlyRuns(): Promise<TaskRun[]> {
  return ((await env.CACHE.get(TASKS_KEY, 'json')) as TaskRun[] | null) ?? [];
}

export interface QueueState {
  failed: number;
  waiting: number;
  /** Running past the point a live Worker would have finished: cut off. */
  stuck: number;
}

export async function queueState(): Promise<QueueState> {
  const row = await env.DB.prepare(
    `SELECT (SELECT count(*) FROM job WHERE status = 'failed') AS failed,
            (SELECT count(*) FROM job WHERE status = 'queued') AS waiting,
            (SELECT count(*) FROM job WHERE status = 'running'
               AND started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-15 minutes')) AS stuck`,
  ).first<QueueState>();
  return row ?? { failed: 0, waiting: 0, stuck: 0 };
}

// D1 reads, from Cloudflare's GraphQL analytics (the numbers behind
// `wrangler d1 insights`). Needs an API token with Account Analytics: Read,
// pasted as the secret CF_ANALYTICS_TOKEN; without it, this says so.

export interface Statement {
  query: string;
  rowsRead: number;
  runs: number;
}

export interface ReadsToday {
  rowsRead: number;
  rowsWritten: number;
  queries: number;
  heaviest: Statement[];
}

const DATABASE_ID = '1def270c-5393-4f62-a025-eec092098626';

async function graphql<T>(query: string, variables: object): Promise<T> {
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await response.json()) as { data?: T; errors?: { message: string }[] | null };
  if (!response.ok || body.errors?.length || !body.data) {
    throw new Error(body.errors?.[0]?.message ?? `Cloudflare analytics answered ${response.status}.`);
  }
  return body.data;
}

/** Since midnight UTC, when D1's daily allowance starts again. Null without a token. */
export async function readsToday(now = new Date()): Promise<ReadsToday | null> {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) return null;
  const day = now.toISOString().slice(0, 10);
  const hour = `${now.toISOString().slice(0, 13)}:00:00Z`;
  type Totals = { viewer: { accounts: { d1AnalyticsAdaptiveGroups: { sum: { rowsRead: number; rowsWritten: number; readQueries: number; writeQueries: number } }[] }[] } };
  type Heavy = { viewer: { accounts: { d1QueriesAdaptiveGroups: { sum: { rowsRead: number }; count: number; dimensions: { query: string } }[] }[] } };
  const [totals, heavy] = await Promise.all([
    graphql<Totals>(
      `query($a: string, $f: AccountD1AnalyticsAdaptiveGroupsFilter_InputObject) {
         viewer { accounts(filter: {accountTag: $a}) {
           d1AnalyticsAdaptiveGroups(limit: 1, filter: $f) { sum { rowsRead rowsWritten readQueries writeQueries } }
         } } }`,
      { a: env.CF_ACCOUNT_ID, f: { date_geq: day, databaseId: DATABASE_ID } },
    ),
    graphql<Heavy>(
      `query($a: string, $f: ZoneWorkersRequestsFilter_InputObject) {
         viewer { accounts(filter: {accountTag: $a}) {
           d1QueriesAdaptiveGroups(limit: 8, filter: $f, orderBy: [sum_rowsRead_DESC]) { sum { rowsRead } count dimensions { query } }
         } } }`,
      { a: env.CF_ACCOUNT_ID, f: { AND: [{ datetimeHour_geq: `${day}T00:00:00Z`, datetimeHour_leq: hour, databaseId: DATABASE_ID }] } },
    ),
  ]);
  const sum = totals.viewer.accounts[0]?.d1AnalyticsAdaptiveGroups[0]?.sum;
  return {
    rowsRead: sum?.rowsRead ?? 0,
    rowsWritten: sum?.rowsWritten ?? 0,
    queries: (sum?.readQueries ?? 0) + (sum?.writeQueries ?? 0),
    heaviest: (heavy.viewer.accounts[0]?.d1QueriesAdaptiveGroups ?? []).map((g) => ({
      query: g.dimensions.query.replace(/\s+/g, ' ').trim(),
      rowsRead: g.sum.rowsRead,
      runs: g.count,
    })),
  };
}
