import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { migratedDb, seedLibrary } from '../test/db';
import { DERIVE_THRESHOLD, deriveAlbumGenres } from './genres';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

/** The derivation as it was done in SQL before it moved to code (genres.ts), kept as the reference. */
function referenceDerive(threshold: number): string[] {
  db.exec(`DELETE FROM genre_tag WHERE entity_type = 'release_group' AND source = 'derived'`);
  db.prepare(
    `INSERT INTO genre_tag (entity_type, entity_id, genre_id, source, weight)
     WITH canon AS (SELECT DISTINCT c.release_group_id, t.recording_id FROM v_release_group_canonical c JOIN track t ON t.release_id = c.release_id),
     sizes AS (SELECT release_group_id, count(*) AS n FROM canon GROUP BY release_group_id),
     tagged AS (
       SELECT canon.release_group_id, gt.genre_id, count(DISTINCT canon.recording_id) AS k
       FROM canon JOIN genre_tag gt ON gt.entity_type = 'recording' AND gt.entity_id = canon.recording_id AND gt.source <> 'derived'
       GROUP BY canon.release_group_id, gt.genre_id)
     SELECT 'release_group', tagged.release_group_id, tagged.genre_id, 'derived', round(1.0 * k / n, 3)
     FROM tagged JOIN sizes ON sizes.release_group_id = tagged.release_group_id WHERE 1.0 * k / n >= ?1`,
  ).run(threshold);
  db.prepare(
    `INSERT INTO genre_tag (entity_type, entity_id, genre_id, source, weight)
     WITH canon AS (SELECT DISTINCT c.release_group_id, t.recording_id FROM v_release_group_canonical c JOIN track t ON t.release_id = c.release_id),
     sizes AS (SELECT release_group_id, count(*) AS n FROM canon GROUP BY release_group_id),
     bare AS (SELECT release_group_id FROM sizes WHERE NOT EXISTS (SELECT 1 FROM genre_tag g WHERE g.entity_type = 'release_group' AND g.entity_id = sizes.release_group_id)),
     elsewhere AS (
       SELECT canon.release_group_id, canon.recording_id, rg.genre_id FROM canon
       JOIN track t2 ON t2.recording_id = canon.recording_id
       JOIN release r2 ON r2.id = t2.release_id AND r2.release_group_id <> canon.release_group_id
       JOIN v_release_group_genre rg ON rg.release_group_id = r2.release_group_id
       WHERE canon.release_group_id IN (SELECT release_group_id FROM bare)),
     tagged AS (SELECT release_group_id, genre_id, count(DISTINCT recording_id) AS k FROM elsewhere GROUP BY release_group_id, genre_id)
     SELECT 'release_group', tagged.release_group_id, tagged.genre_id, 'derived', round(1.0 * k / n, 3)
     FROM tagged JOIN sizes ON sizes.release_group_id = tagged.release_group_id WHERE 1.0 * k / n >= ?1`,
  ).run(threshold);
  return derived();
}

const derived = () =>
  (db.prepare(`SELECT entity_id, genre_id, weight FROM genre_tag WHERE entity_type = 'release_group' AND source = 'derived' ORDER BY 1, 2`).all() as {
    entity_id: string;
    genre_id: string;
    weight: number;
  }[]).map((r) => `${r.entity_id} ${r.genre_id} ${r.weight}`);

describe('album genres from track genres', () => {
  it('derives exactly what the SQL did, and writes nothing when nothing changed', async () => {
    const tag = (r: string, g: string, source = 'musicbrainz') =>
      db.prepare(`INSERT OR IGNORE INTO genre_tag (entity_type, entity_id, genre_id, source, weight) VALUES ('recording', ?, ?, ?, 1)`).run(r, g, source);
    tag('a1', 'g-rock');
    tag('a2', 'g-rock');
    tag('a3', 'g-pop');
    tag('b1', 'g-indie', 'manual');
    tag('c1', 'g-rock');
    // An album's own tags: album C keeps them, so it is not bare.
    db.prepare(`INSERT OR IGNORE INTO genre_tag (entity_type, entity_id, genre_id, source, weight) VALUES ('release_group', 'rg-c', 'g-bedroom', 'manual', 1)`).run();

    const expected = referenceDerive(DERIVE_THRESHOLD);
    db.exec(`DELETE FROM genre_tag WHERE entity_type = 'release_group' AND source = 'derived'`);
    await deriveAlbumGenres();
    expect(derived()).toEqual(expected);

    // Again: nothing to write, so the library's stamp (library_version) stays.
    const version = () => (db.prepare(`SELECT value FROM app_setting WHERE key = 'library_version'`).get() as { value: string } | undefined)?.value;
    const before = version();
    await deriveAlbumGenres();
    expect(version()).toBe(before);
    expect(derived()).toEqual(expected);
  });
});
