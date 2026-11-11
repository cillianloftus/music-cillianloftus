import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../../test/d1';
import { migratedDb } from '../../test/db';
import { claimNext, enqueue } from './queue';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  (env as { DB: D1Database }).DB = d1(db);
});

const job = (id: string) => db.prepare('SELECT status, attempts, error FROM job WHERE id = ?').get(id) as { status: string; attempts: number; error: string | null };
const cutOff = (id: string) => db.prepare(`UPDATE job SET started_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`).run(id);

describe('the job queue', () => {
  it('counts each start', async () => {
    const id = await enqueue('backup', {});
    expect((await claimNext())?.id).toBe(id);
    expect(job(id)).toMatchObject({ status: 'running', attempts: 1 });
  });

  it('takes up a job whose Worker was cut off, but fails it after three tries', async () => {
    const id = await enqueue('backup', {});
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect((await claimNext())?.id).toBe(id);
      expect(job(id).attempts).toBe(attempt);
      cutOff(id);
    }
    expect(await claimNext()).toBeNull();
    expect(job(id)).toMatchObject({ status: 'failed', attempts: 3 });
    expect(job(id).error).toMatch(/Stopped after 3 tries/);
  });

  it('moves on to the next job once a stuck one has failed', async () => {
    const stuck = await enqueue('backup', {});
    const next = await enqueue('backup', {});
    db.prepare(`UPDATE job SET created_at = '2025-01-01T00:00:00.000Z' WHERE id = ?`).run(stuck);
    for (let attempt = 1; attempt <= 3; attempt++) {
      await claimNext();
      cutOff(stuck);
    }
    expect((await claimNext())?.id).toBe(next);
    expect(job(stuck).status).toBe('failed');
  });
});
