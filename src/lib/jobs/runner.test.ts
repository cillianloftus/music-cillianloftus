import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { d1 } from '../../test/d1';
import { migratedDb } from '../../test/db';
import { enqueue } from './queue';
import { runJobs } from './runner';

// Each backup job does whatever the next queued outcome says.
const outcomes: Array<'ok' | 'limit' | 'throttled'> = [];
vi.mock('../backup/store', async () => {
  const { MusicBrainzError } = await import('../musicbrainz/client');
  return {
    runBackup: async () => {
      const next = outcomes.shift();
      if (next === 'limit') throw new Error('Too many subrequests by single Worker invocation.');
      if (next === 'throttled') throw new MusicBrainzError('MusicBrainz returned 503 for release/x', 503);
      return { summary: { rows: 1 } };
    },
  };
});

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

  it('sends a job MusicBrainz refuses to the back of the queue, and moves on', async () => {
    const first = await enqueue('backup', {});
    await enqueue('backup', {});
    outcomes.push('throttled', 'ok', 'ok');
    // The second ran while the first waited behind it; then the first, on its second try.
    expect(await runJobs({ budgetMs: 10_000 })).toBe(2);
    const row = db.prepare('SELECT status, attempts FROM job WHERE id = ?').get(first) as { status: string; attempts: number };
    expect(row).toEqual({ status: 'done', attempts: 2 });
  });

  it('runs one at a time: a run finding the lease held does nothing, one finding it expired runs', async () => {
    await enqueue('backup', {});
    const until = (ms: number) => `${new Date(Date.now() + ms).toISOString()}|another-run`;
    db.prepare(`INSERT INTO app_setting (key, value) VALUES ('jobs_lease', ?)`).run(until(60_000));
    outcomes.push('ok');
    expect(await runJobs({ budgetMs: 10_000 })).toBe(0);
    expect(statuses()).toEqual(['queued']);
    // The other run died without giving it up: once expired, the lease is free.
    db.prepare(`UPDATE app_setting SET value = ? WHERE key = 'jobs_lease'`).run(until(-1_000));
    expect(await runJobs({ budgetMs: 10_000 })).toBe(1);
    // Given up at the end, so the next run need not wait.
    expect(db.prepare(`SELECT value FROM app_setting WHERE key = 'jobs_lease'`).get()).toEqual({ value: '' });
  });

  it('stops the run when MusicBrainz refuses three in a row: it is down', async () => {
    for (let i = 0; i < 4; i++) await enqueue('backup', {});
    outcomes.push('throttled', 'throttled', 'throttled');
    expect(await runJobs({ budgetMs: 10_000 })).toBe(0);
    expect(statuses()).toEqual(['queued', 'queued', 'queued', 'queued']);
  });

  it('fails a job that runs out on a fresh allowance: it is too big on its own', async () => {
    await enqueue('backup', {});
    await enqueue('backup', {});
    outcomes.push('limit', 'ok');
    expect(await runJobs({ budgetMs: 10_000 })).toBe(2);
    expect(statuses()).toEqual(['failed', 'done']);
  });
});
