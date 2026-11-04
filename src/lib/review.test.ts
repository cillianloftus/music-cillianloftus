import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';
import { detectAnomalies, dismiss, findAnomalies, linkWork, openAnomalies, ReviewError } from './review';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

const credit = (entity_type: string, entity_id: string, artist_id: string) => ({
  id: `c-${entity_type}-${entity_id}-${artist_id}`,
  entity_type,
  entity_id,
  artist_id,
  role: 'primary',
});

/** Duplicates of the kind a hand-typed entry next to an import produces. */
function seedDuplicates() {
  insert(db, 'artist', [{ id: 'art-x2', name: 'XAVIER', sort_name: 'Xavier', source: 'manual' }]);
  insert(db, 'recording', [{ id: 'a2-dup', title: 'Song A2 - Remastered 2011', source: 'manual' }]);
  insert(db, 'release_group', [{ id: 'rg-a-deluxe', title: 'Album A (Deluxe Edition)', type: 'album', source: 'manual' }]);
  insert(db, 'release', [{ id: 'r-ad', release_group_id: 'rg-a-deluxe', title: 'Album A (Deluxe Edition)', source: 'manual' }]);
  insert(db, 'track', [{ id: 't-ad', release_id: 'r-ad', recording_id: 'a2-dup', position: 1 }]);
  insert(db, 'artist_credit', [credit('recording', 'a2-dup', 'art-x'), credit('release_group', 'rg-a-deluxe', 'art-x')]);
}

const has = (findings: { kind: string; entity_a: string; entity_b: string | null }[], kind: string, a: string, b: string | null = null) =>
  findings.some((f) => f.kind === kind && f.entity_a === a && f.entity_b === b);

describe('rules', () => {
  it('finds same-name artists, ignoring case and punctuation', async () => {
    seedDuplicates();
    expect(has(await findAnomalies(), 'duplicate_artist_name', 'art-x', 'art-x2')).toBe(true);
  });

  it('finds same-titled recordings by one artist, edition words aside', async () => {
    seedDuplicates();
    const findings = await findAnomalies();
    expect(has(findings, 'near_duplicate_recording', 'a2', 'a2-dup')).toBe(true);
    // a1 and its cover c1 share a work but are by different artists: fine.
    expect(findings.some((f) => f.kind === 'near_duplicate_recording' && f.entity_a === 'a1')).toBe(false);
  });

  it('does not pair recordings already on one work', async () => {
    seedDuplicates();
    db.exec(`UPDATE recording SET work_id = 'w-a1' WHERE id IN ('a2', 'a2-dup')`);
    expect(has(await findAnomalies(), 'near_duplicate_recording', 'a2', 'a2-dup')).toBe(false);
  });

  it('finds a deluxe edition filed as an album of its own', async () => {
    seedDuplicates();
    expect(has(await findAnomalies(), 'near_duplicate_release_group', 'rg-a', 'rg-a-deluxe')).toBe(true);
  });

  it('finds a group whose editions differ wildly in length', async () => {
    insert(db, 'release', [{ id: 'r-b-box', release_group_id: 'rg-b', title: 'Album B (Box)', source: 'manual' }]);
    insert(
      db,
      'track',
      ['a1', 'a2', 'a3', 'a4', 'b1', 'b2'].map((recording_id, i) => ({ id: `t-box-${i}`, release_id: 'r-b-box', recording_id, position: i + 1 })),
    );
    const findings = await findAnomalies();
    expect(has(findings, 'track_count_mismatch', 'rg-b')).toBe(true);
    // Album A's 3 and 4 tracks are an ordinary deluxe.
    expect(has(findings, 'track_count_mismatch', 'rg-a')).toBe(false);
  });

  it('finds rated recordings with no work, albums without art, and recordings on no release', async () => {
    insert(db, 'recording', [{ id: 'loose', title: 'Loose', source: 'manual' }]);
    db.exec(`UPDATE release SET art_key = 'art/release/r-b' WHERE id = 'r-b'`);
    const findings = await findAnomalies();
    expect(has(findings, 'unlinked_rated_recording', 'b1')).toBe(true);
    expect(has(findings, 'unlinked_rated_recording', 'a1')).toBe(false); // has a work
    expect(has(findings, 'missing_cover_art', 'rg-a')).toBe(true);
    expect(has(findings, 'missing_cover_art', 'rg-b')).toBe(false);
    expect(has(findings, 'orphaned_track', 'loose')).toBe(true);
  });
});

describe('detection', () => {
  it('raises each finding once, however often it runs', async () => {
    seedDuplicates();
    const first = await detectAnomalies();
    expect(first.raised).toBeGreaterThan(0);
    const second = await detectAnomalies();
    expect(second).toMatchObject({ raised: 0, cleared: 0, open: first.open });
  });

  it('closes an anomaly by itself once the rule stops firing', async () => {
    await detectAnomalies();
    db.exec(`UPDATE release SET art_key = 'art/x' WHERE id = 'r-c'`);
    const run = await detectAnomalies();
    expect(run.cleared).toBe(1);
    expect((await openAnomalies()).some((a) => a.kind === 'missing_cover_art' && a.entity_a === 'rg-c')).toBe(false);
  });

  it('never raises a pair again once judged distinct', async () => {
    seedDuplicates();
    await detectAnomalies();
    const artists = (await openAnomalies()).find((a) => a.kind === 'duplicate_artist_name')!;
    await dismiss(artists.id);
    expect(db.prepare(`SELECT * FROM confirmed_distinct`).all()).toEqual([{ entity_type: 'artist', id_a: 'art-x', id_b: 'art-x2' }]);

    await detectAnomalies();
    expect((await openAnomalies()).some((a) => a.kind === 'duplicate_artist_name')).toBe(false);
  });

  it('never raises a dismissed single-entity anomaly again', async () => {
    await detectAnomalies();
    const art = (await openAnomalies()).find((a) => a.kind === 'missing_cover_art')!;
    await dismiss(art.id);
    await detectAnomalies();
    expect((await openAnomalies()).some((a) => a.id === art.id || (a.kind === art.kind && a.entity_a === art.entity_a))).toBe(false);
  });
});

describe('linking a work', () => {
  it('puts two recordings on one new work, which then stops the anomaly', async () => {
    seedDuplicates();
    await detectAnomalies();
    const dup = (await openAnomalies()).find((a) => a.kind === 'near_duplicate_recording')!;
    const workId = await linkWork(dup.id);
    const works = db.prepare(`SELECT id, work_id FROM recording WHERE id IN ('a2', 'a2-dup') ORDER BY id`).all();
    expect(works).toEqual([
      { id: 'a2', work_id: workId },
      { id: 'a2-dup', work_id: workId },
    ]);
    expect(db.prepare(`SELECT title, source FROM work WHERE id = ?`).get(workId)).toEqual({ title: 'Song A2', source: 'manual' });
    await detectAnomalies();
    expect((await openAnomalies()).some((a) => a.kind === 'near_duplicate_recording')).toBe(false);
  });

  it('reuses the work one recording already has', async () => {
    seedDuplicates();
    insert(db, 'work', [{ id: 'w-a2', title: 'Song A2', source: 'manual' }]);
    db.exec(`UPDATE recording SET work_id = 'w-a2' WHERE id = 'a2'`);
    await detectAnomalies();
    const dup = (await openAnomalies()).find((a) => a.kind === 'near_duplicate_recording')!;
    expect(await linkWork(dup.id)).toBe('w-a2');
  });

  it('refuses to move a recording between works', async () => {
    seedDuplicates();
    insert(db, 'work', [
      { id: 'w-1', title: 'One', source: 'manual' },
      { id: 'w-2', title: 'Two', source: 'manual' },
    ]);
    db.exec(`UPDATE recording SET work_id = 'w-1' WHERE id = 'a2'; UPDATE recording SET work_id = 'w-2' WHERE id = 'a2-dup'`);
    await detectAnomalies();
    const dup = (await openAnomalies()).find((a) => a.kind === 'near_duplicate_recording')!;
    await expect(linkWork(dup.id)).rejects.toBeInstanceOf(ReviewError);
  });

  it('cannot resolve an item twice', async () => {
    await detectAnomalies();
    const [first] = await openAnomalies();
    await dismiss(first!.id);
    await expect(dismiss(first!.id)).rejects.toBeInstanceOf(ReviewError);
  });
});
