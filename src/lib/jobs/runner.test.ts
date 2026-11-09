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

describe('settling after imports', () => {
  const flag = () => (db.prepare(`SELECT value FROM app_setting WHERE key = 'library_settle_due'`).get() as { value: string } | undefined)?.value;

  it('waits while jobs are queued, then runs once and clears the flag', async () => {
    const { settleIfIdle } = await import('./runner');
    db.exec(`INSERT INTO app_setting (key, value) VALUES ('library_settle_due', '1')`);
    await enqueue('backup', {});
    expect(await settleIfIdle()).toBe(false);
    expect(flag()).toBe('1');

    outcomes.push('ok');
    await runJobs({ budgetMs: 10_000 });
    // The run that emptied the queue settled.
    expect(flag()).toBe('0');
    expect(await settleIfIdle()).toBe(false);
  });

  it('settles at most every twenty minutes, keeping the mark until it can', async () => {
    const { settleIfIdle, SETTLE_EVERY_MS } = await import('./runner');
    const start = new Date('2026-11-10T00:00:00.000Z');
    db.exec(`INSERT INTO app_setting (key, value) VALUES ('library_settle_due', '1')`);
    expect(await settleIfIdle(start)).toBe(true);
    // Another album in, ten minutes later: due, but too soon.
    db.exec(`UPDATE app_setting SET value = '1' WHERE key = 'library_settle_due'`);
    expect(await settleIfIdle(new Date(start.getTime() + SETTLE_EVERY_MS / 2))).toBe(false);
    expect(flag()).toBe('1');
    expect(await settleIfIdle(new Date(start.getTime() + SETTLE_EVERY_MS + 1000))).toBe(true);
    expect(flag()).toBe('0');
  });
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
