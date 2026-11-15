import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../../test/d1';
import { migratedDb } from '../../test/db';
import { claimNext, complete, enqueue, enqueueMany, fail, jobCounts, pace, queueProgress, recountJobs, removeQueued, retry } from './queue';

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

  it('sends a job whose Worker was cut off to the back of the queue', async () => {
    const stuck = await enqueue('backup', {});
    const next = await enqueue('backup', {});
    db.prepare(`UPDATE job SET created_at = '2025-01-01T00:00:00.000Z' WHERE id = ?`).run(stuck);
    // Queued well before now, so "the back" is plainly behind it.
    db.prepare(`UPDATE job SET created_at = '2025-06-01T00:00:00.000Z' WHERE id = ?`).run(next);
    expect((await claimNext())?.id).toBe(stuck);
    cutOff(stuck);
    // The one behind it goes first; the cut-off one waits its turn again.
    expect((await claimNext())?.id).toBe(next);
    expect(job(stuck)).toMatchObject({ status: 'queued', attempts: 1 });
    expect((await claimNext())?.id).toBe(stuck);
  });
});

describe('kept job counts (0070)', () => {
  const counted = async () => {
    const kept = await jobCounts();
    await recountJobs();
    expect(await jobCounts()).toEqual(kept);
    return kept;
  };

  it('follow every move without counting the table', async () => {
    const [a, b, c] = await enqueueMany('import_release', [1, 2, 3].map((n) => ({ label: `Album ${n}` }) as never));
    expect(await counted()).toEqual({ queued: 3, running: 0, done: 0, failed: 0 });
    await claimNext();
    expect(await counted()).toMatchObject({ queued: 2, running: 1 });
    await complete(a!, {});
    await claimNext();
    await fail(b!, new Error('no'));
    expect(await counted()).toEqual({ queued: 1, running: 0, done: 1, failed: 1 });
    await retry(b!);
    await removeQueued(c!);
    expect(await counted()).toEqual({ queued: 1, running: 0, done: 1, failed: 0 });
  });

  it('give the whole queue with what is running now', async () => {
    await enqueueMany('import_release', [{ label: 'Ours' }, { label: 'Pon de Replay' }] as never);
    await claimNext();
    const progress = await queueProgress();
    expect(progress.counts).toMatchObject({ queued: 1, running: 1 });
    expect(progress.current).toBe('Ours');
    expect(progress.perHour).toBeNull();
  });
});

describe('pace', () => {
  const at = (minutesAgo: number) => new Date(Date.UTC(2026, 10, 14, 20) - minutesAgo * 60_000).toISOString();
  const now = Date.UTC(2026, 10, 14, 20);

  it('is jobs an hour over the recent finishes', () => {
    // Five finishes two minutes apart: 30 an hour.
    expect(pace([0, 2, 4, 6, 8].map(at), now)).toBeCloseTo(30);
  });

  it('is unknown with too few finishes or when work stopped long ago', () => {
    expect(pace([at(0), at(1)], now)).toBeNull();
    expect(pace([20, 22, 24].map(at), now)).toBeNull();
  });
});

describe('the priority lane (0071)', () => {
  it('runs what was asked for ahead of a long bulk queue, oldest first within each', async () => {
    const bulk = await enqueueMany('import_release', [{ label: 'Bulk 1' }, { label: 'Bulk 2' }] as never);
    const refreshA = await enqueue('import_release', { label: 'Refresh A' } as never);
    const refreshB = await enqueue('import_release', { label: 'Refresh B' } as never);
    const order: string[] = [];
    for (let job = await claimNext(); job; job = await claimNext()) {
      order.push(job.id);
      await complete(job.id, {});
    }
    expect(order).toEqual([refreshA, refreshB, ...bulk]);
  });

  it('counts what is going first', async () => {
    await enqueueMany('import_release', [{ label: 'Bulk' }] as never);
    await enqueue('import_release', { label: 'Refresh' } as never);
    expect((await queueProgress()).first).toBe(1);
  });
});

describe('batches (0072)', () => {
  it('keep their own counts, and can be put first, sent back in line or emptied', async () => {
    const { createBatch, jobBatch, jobBatches, prioritiseBatch, removeBatchQueued, recountJobs } = await import('./queue');
    const logic = await createBatch('Logic', 'discography');
    const other = await createBatch('Someone else', 'discography');
    await enqueueMany('import_release', [{ label: 'Other 1' }, { label: 'Other 2' }] as never, 0, other);
    const [l1] = await enqueueMany('import_release', [{ label: 'Logic 1' }, { label: 'Logic 2' }, { label: 'Logic 3' }] as never, 0, logic);

    expect(await jobBatch(logic)).toMatchObject({ queued: 3, running: 0, done: 0 });
    // Logic goes first, in its own order.
    expect(await prioritiseBatch(logic, true)).toBe(3);
    expect((await jobBatches()).find((b) => b.id === logic)?.first).toBe(true);
    const job = await claimNext();
    expect(job?.id).toBe(l1);
    await complete(job!.id, {});
    expect(await jobBatch(logic)).toMatchObject({ queued: 2, done: 1 });

    // Back in line: the other batch, queued earlier, is next again.
    await prioritiseBatch(logic, false);
    expect(JSON.parse((await claimNext())!.payload_json).label).toBe('Other 1');

    expect(await removeBatchQueued(logic)).toBe(2);
    const counts = await jobBatch(logic);
    await recountJobs();
    expect(await jobBatch(logic)).toEqual(counts);
    expect(counts).toMatchObject({ queued: 0, running: 0, done: 1, failed: 0 });
  });
});
