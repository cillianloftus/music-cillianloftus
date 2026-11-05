import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { d1 } from '../../test/d1';
import { migratedDb } from '../../test/db';
import { enqueue } from './queue';
import { runJobs } from './runner';

// Each backup job does whatever the next queued outcome says.
const outcomes: Array<'ok' | 'limit'> = [];
vi.mock('../backup/store', () => ({
  runBackup: async () => {
    if (outcomes.shift() === 'limit') throw new Error('Too many subrequests by single Worker invocation.');
    return { summary: { rows: 1 } };
  },
}));

let db: DatabaseSync;
const statuses = () => (db.prepare('SELECT id, status FROM job ORDER BY created_at, rowid').all() as Array<{ id: string; status: string }>).map((j) => j.status);

beforeEach(() => {
  db = migratedDb();
  (env as { DB: D1Database }).DB = d1(db);
  outcomes.length = 0;
});

describe('running out of requests', () => {
  it('puts a job that ran out after others back first, and stops the run', async () => {
    for (let i = 0; i < 3; i++) await enqueue('backup', {});
    outcomes.push('ok', 'limit');
    expect(await runJobs({ budgetMs: 10_000 })).toBe(1);
    expect(statuses()).toEqual(['done', 'queued', 'queued']);

    // The next run starts with it, on a fresh allowance.
    outcomes.push('ok', 'ok');
    expect(await runJobs({ budgetMs: 10_000 })).toBe(2);
    expect(statuses()).toEqual(['done', 'done', 'done']);
  });

  it('fails a job that runs out on a fresh allowance: it is too big on its own', async () => {
    await enqueue('backup', {});
    await enqueue('backup', {});
    outcomes.push('limit', 'ok');
    expect(await runJobs({ budgetMs: 10_000 })).toBe(2);
    expect(statuses()).toEqual(['failed', 'done']);
  });
});
