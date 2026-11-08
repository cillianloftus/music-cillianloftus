import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';
import { detectAnomalies, dismiss, findAnomalies, linkAllVersions, linkWork, matchingAlbumPairs, mergeMatchingAlbums, matchingTrackPairs, mergeMatchingTracks, openAnomalies, ReviewError, same, skip } from './review';

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

describe('which songs are asked about', () => {
  it('leaves out generic titles, other versions by length, and takes only on live releases', async () => {
    seedDuplicates();
    // Generic: two different "Intro"s.
    insert(db, 'recording', [
      { id: 'i1', title: 'Intro', source: 'manual' },
      { id: 'i2', title: 'intro', source: 'manual' },
    ]);
    insert(db, 'track', [
      { id: 't-i1', release_id: 'r-a', recording_id: 'i1', position: 9 },
      { id: 't-i2', release_id: 'r-b', recording_id: 'i2', position: 9 },
    ]);
    insert(db, 'artist_credit', [credit('recording', 'i1', 'art-x'), credit('recording', 'i2', 'art-x')]);
    expect((await findAnomalies()).some((f) => f.entity_a === 'i1' || f.entity_b === 'i1')).toBe(false);

    // A minute apart: another version.
    db.exec(`UPDATE recording SET length_ms = 200000 WHERE id = 'a2'; UPDATE recording SET length_ms = 260000 WHERE id = 'a2-dup'`);
    expect(has(await findAnomalies(), 'near_duplicate_recording', 'a2', 'a2-dup')).toBe(false);
    // A second apart: the same recording.
    db.exec(`UPDATE recording SET length_ms = 201000 WHERE id = 'a2-dup'`);
    expect(has(await findAnomalies(), 'near_duplicate_recording', 'a2', 'a2-dup')).toBe(true);
    // Only on a live album: a live take, not asked about.
    db.exec(`UPDATE release_group SET type = 'live' WHERE id = 'rg-a-deluxe'`);
    expect(has(await findAnomalies(), 'near_duplicate_recording', 'a2', 'a2-dup')).toBe(false);
  });
});

describe('deciding', () => {
  it('skips an item to the back of its list', async () => {
    seedDuplicates();
    await detectAnomalies();
    const [first, second] = await openAnomalies('duplicate_artist_name').then(async (a) => [...a, ...(await openAnomalies())]);
    await skip(first!.id);
    const after = await openAnomalies();
    expect(after.filter((a) => a.kind === first!.kind).at(-1)!.id).toBe(first!.id);
    expect(second).toBeDefined();
  });

  it('merges a same-song pair whole: tracks, ratings, plays and the redirect', async () => {
    seedDuplicates();
    insert(db, 'rating', [
      { id: 'r-dup', user_id: 'u-owner', entity_type: 'recording', entity_id: 'a2-dup', depth: 'gut', gut_score: 3, rated_at: '2026-03-01T00:00:00.000Z' },
    ]);
    insert(db, 'play', [{ id: 'p1', user_id: 'u-owner', recording_id: 'a2-dup', played_at: '2026-03-02T00:00:00.000Z', ms_played: 200000, source: 'lastfm' }]);
    await detectAnomalies();
    const dup = (await openAnomalies('near_duplicate_recording'))[0]!;
    await same(dup.id);

    // Both rated: a2 is on two releases, so it stays; a2-dup's track, rating and play move to it.
    expect(db.prepare(`SELECT count(*) n FROM recording WHERE id = 'a2-dup'`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT recording_id FROM track WHERE id = 't-ad'`).get()).toEqual({ recording_id: 'a2' });
    expect(db.prepare(`SELECT entity_id FROM rating WHERE id = 'r-dup'`).get()).toEqual({ entity_id: 'a2' });
    expect(db.prepare(`SELECT recording_id FROM play WHERE id = 'p1'`).get()).toEqual({ recording_id: 'a2' });
    expect(db.prepare(`SELECT new_id FROM entity_redirect WHERE old_id = 'a2-dup'`).get()).toEqual({ new_id: 'a2' });
    expect((await openAnomalies('near_duplicate_recording')).length).toBe(0);
  });

  it('merges every pair whose lengths match, and only those', async () => {
    seedDuplicates();
    db.exec(`UPDATE recording SET length_ms = 200000 WHERE id = 'a2'; UPDATE recording SET length_ms = 201500 WHERE id = 'a2-dup'`);
    await detectAnomalies();
    expect((await matchingTrackPairs()).length).toBe(1);
    expect(await mergeMatchingTracks({ budgetMs: 10_000 })).toEqual({ merged: 1, left: 0 });
    expect(db.prepare(`SELECT count(*) n FROM recording WHERE id IN ('a2', 'a2-dup')`).get()).toEqual({ n: 1 });
  });
});

describe('albums that are plainly one', () => {
  it('merges a deluxe filed as its own album into the album, as an edition', async () => {
    seedDuplicates();
    insert(db, 'release_group', [{ id: 'rg-a-single', title: 'Album A', type: 'single', source: 'manual' }]);
    insert(db, 'artist_credit', [credit('release_group', 'rg-a-single', 'art-x')]);
    await detectAnomalies();
    // The single of the same name is a different kind of release: not taken.
    expect((await matchingAlbumPairs()).map((p) => [p.entity_a, p.entity_b])).toEqual([['rg-a', 'rg-a-deluxe']]);
    expect(await mergeMatchingAlbums({ budgetMs: 10_000 })).toEqual({ merged: 1, left: 0 });
    expect(db.prepare(`SELECT release_group_id FROM release WHERE id = 'r-ad'`).get()).toEqual({ release_group_id: 'rg-a' });
  });
});

describe('versions of a song', () => {
  /** Two remixes of Song A2, credited to its artist, and a track that only looks like one. */
  function seedRemixes() {
    insert(db, 'recording', [
      { id: 'zz-remix', title: 'Song A2 (Someone Remix)', source: 'manual' },
      { id: 'aa-sped', title: 'Song A2 - Sped Up', source: 'manual' },
    ]);
    insert(db, 'artist_credit', [credit('recording', 'zz-remix', 'art-x'), credit('recording', 'aa-sped', 'art-x')]);
  }

  it('raises each version beside the song, original first', async () => {
    seedRemixes();
    const findings = await findAnomalies();
    expect(has(findings, 'version_of_recording', 'a2', 'zz-remix')).toBe(true);
    expect(has(findings, 'version_of_recording', 'a2', 'aa-sped')).toBe(true);
  });

  it('remembers "Not a version", though the version sorts before the song', async () => {
    seedRemixes();
    await detectAnomalies();
    const open = await openAnomalies('version_of_recording');
    const sped = open.find((a) => a.entity_b === 'aa-sped')!;
    await dismiss(sped.id);
    expect(db.prepare(`SELECT id_a, id_b FROM confirmed_distinct WHERE entity_type = 'recording'`).all()).toEqual([{ id_a: 'a2', id_b: 'aa-sped' }]);
    await detectAnomalies();
    expect((await openAnomalies('version_of_recording')).map((a) => a.entity_b)).toEqual(['zz-remix']);
  });

  it('links them all into one song', async () => {
    seedRemixes();
    await detectAnomalies();
    const run = await linkAllVersions({ budgetMs: 10_000 });
    expect(run).toEqual({ merged: 2, left: 0 });
    const works = db.prepare(`SELECT DISTINCT work_id FROM recording WHERE id IN ('a2', 'zz-remix', 'aa-sped')`).all() as { work_id: string }[];
    expect(works).toHaveLength(1);
    expect(works[0]!.work_id).not.toBeNull();
  });
});
