import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';
import { addRating, ratingInput } from './ratings';
import { detectAnomalies, findAnomalies } from './review';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

const outdated = async () => (await findAnomalies()).filter((f) => f.kind === 'outdated_rating').map((f) => f.entity_a).sort();
const open = () =>
  (db.prepare(`SELECT entity_a FROM anomaly WHERE kind = 'outdated_rating' AND status = 'open' ORDER BY entity_a`).all() as { entity_a: string }[]).map((r) => r.entity_a);

describe('older ratings for review', () => {
  beforeEach(() => {
    insert(db, 'rating', [
      // One production score, before the split.
      { id: 'old-prod', user_id: 'u-owner', entity_type: 'recording', entity_id: 'a1', depth: 'detailed', production: 8, songwriting: 8, rated_at: '2026-10-01T00:00:00.000Z' },
      // Split, but before originality.
      { id: 'old-orig', user_id: 'u-owner', entity_type: 'recording', entity_id: 'a2', depth: 'detailed', arrangement: 7, sound: 7, songwriting: 7, rated_at: '2026-10-01T00:00:00.000Z' },
      // Up to date, originality marked as not applying.
      { id: 'na', user_id: 'u-owner', entity_type: 'recording', entity_id: 'b1', depth: 'detailed', arrangement: 7, sound: 6, songwriting: 7, not_applicable: '["originality"]', rated_at: '2026-10-01T00:00:00.000Z' },
      // A friend's old rating is theirs, not the owner's to review.
      { id: 'friend', user_id: 'u-friend', entity_type: 'recording', entity_id: 'b2', depth: 'detailed', production: 6, rated_at: '2026-10-01T00:00:00.000Z' },
    ]);
  });

  it('raises the owner’s detailed ratings without split arrangement and sound, or without originality', async () => {
    // a3 is the seed's gut rating: never meant to have axes.
    expect(await outdated()).toEqual(['a1', 'a2']);
  });

  it('goes once the track is rated again with every axis, not when rated again without originality', async () => {
    await detectAnomalies();
    expect(open()).toEqual(['a1', 'a2']);
    // ratingInput wants a uuid id; the seed's ids are short, so the parsed input is given the real one.
    const input = (entity_id: string, originality: number | null) => ({
      ...ratingInput.parse({ entity_type: 'recording', entity_id: '00000000-0000-4000-8000-000000000000', arrangement: 8, sound: 7, songwriting: 8, originality }),
      entity_id,
    });
    // Rated again, still without originality: stays.
    insert(db, 'rating', [{ id: 'again', user_id: 'u-owner', entity_type: 'recording', entity_id: 'a2', depth: 'detailed', arrangement: 8, sound: 7, rated_at: '2026-10-02T00:00:00.000Z' }]);
    await detectAnomalies();
    expect(open()).toEqual(['a1', 'a2']);
    await addRating('u-owner', input('a2', 8));
    expect(open()).toEqual(['a1']);
    expect(await outdated()).toEqual(['a1']);
  });
});
