import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { migratedDb, seedLibrary } from '../test/db';
import { claimNext, complete, enqueue, fail, retry } from './jobs/queue';
import { addRating, ratingHistory, ratingInput } from './ratings';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

const target = { entity: 'release-group' as const, mbid: '416bb5e5-c7d1-3977-8fd7-7c9daf6c2be6' };

describe('job queue', () => {
  it('hands each job to exactly one claimant, oldest first', async () => {
    const first = await enqueue('import_release', { source: 'musicbrainz', target });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await enqueue('import_release', { source: 'musicbrainz', target });

    expect((await claimNext())?.id).toBe(first);
    expect((await claimNext())?.id).toBe(second);
    expect(await claimNext()).toBeNull();
  });

  it('records failures and lets them be retried', async () => {
    const id = await enqueue('import_release', { source: 'musicbrainz', target });
    await claimNext();
    await fail(id, new Error('MusicBrainz returned 503'));
    expect(db.prepare('SELECT status, error FROM job WHERE id = ?').get(id)).toMatchObject({
      status: 'failed',
      error: 'MusicBrainz returned 503',
    });

    expect(await retry(id)).toBe(true);
    expect((await claimNext())?.id).toBe(id);
  });

  it('only retries failed jobs', async () => {
    const id = await enqueue('import_release', { source: 'musicbrainz', target });
    await claimNext();
    await complete(id, {});
    expect(await retry(id)).toBe(false);
  });

  it('reclaims a job whose worker died mid-run', async () => {
    const id = await enqueue('import_release', { source: 'musicbrainz', target });
    await claimNext();
    expect(await claimNext()).toBeNull();
    db.prepare("UPDATE job SET started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-16 minutes') WHERE id = ?").run(id);
    expect((await claimNext())?.id).toBe(id);
  });
});

describe('ratings', () => {
  const recording = '00000000-0000-4000-8000-000000000001';

  beforeEach(() => {
    db.prepare("INSERT INTO recording (id, title, source) VALUES (?, 'Track', 'manual')").run(recording);
  });

  it('derives depth from what was given', async () => {
    await addRating('u-owner', ratingInput.parse({ entity_type: 'recording', entity_id: recording, gut_score: '8' }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await addRating(
      'u-owner',
      ratingInput.parse({ entity_type: 'recording', entity_id: recording, gut_score: '8', production: '7.5', lyrics: '' }),
    );
    const history = await ratingHistory('u-owner', 'recording', recording);
    expect(history.map((row) => row.depth)).toEqual(['detailed', 'gut']);
    expect(history[0]).toMatchObject({ production: 7.5, lyrics: null });
  });

  it.each([
    [{ gut_score: '11' }, 'too big'],
    [{ gut_score: '7.3' }, 'multiple'],
    [{ sequencing: '8' }, 'does not apply to a track'],
    [{}, 'gut score or at least one axis'],
  ])('rejects %j', (fields, message) => {
    const result = ratingInput.safeParse({ entity_type: 'recording', entity_id: recording, ...fields });
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((issue) => issue.message).join(' ').toLowerCase()).toContain(message.toLowerCase());
  });
});
