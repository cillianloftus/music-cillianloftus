/**
 * "A backup never restored from is a hypothesis" (ARCHITECTURE.md §10).
 * This restores one on every test run.
 */

import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../../test/d1';
import { insert, migratedDb, seedLibrary } from '../../test/db';
import { dumpDatabase } from './dump';
import { backupToSql, backupToSqlParts, readKeys, restoreOrder, summarise, type Backup } from './format';

let source: DatabaseSync;

beforeEach(() => {
  source = migratedDb();
  seedLibrary(source);
  // Data that exercises the awkward cases: a circular reference, quotes,
  // unicode, a self-referencing genre, and secrets that must be left out.
  source.exec("UPDATE work SET preferred_recording_id = 'a1' WHERE id = 'w-a1'");
  insert(source, 'artist', [{ id: 'art-q', name: "Sinéad O'Connor; DROP TABLE x", sort_name: 'O’Connor, Sinéad', source: 'manual' }]);
  insert(source, 'spotify_token', [{ user_id: 'u-owner', refresh_token: 'secret', authorized_at: '2026-01-01T00:00:00Z' }]);
  (env as { DB: D1Database }).DB = d1(source);
});

function tableRows(db: DatabaseSync, table: string) {
  return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
}

function keysOf(db: DatabaseSync) {
  return readKeys((sql, ...params) => db.prepare(sql).all(...params));
}

/** As D1 runs a file: one transaction, rolled back whole if anything fails. */
function inTransaction(db: DatabaseSync, sql: string) {
  db.exec('BEGIN');
  try {
    db.exec(sql);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function restore(backup: Backup): DatabaseSync {
  const target = migratedDb();
  inTransaction(target, backupToSql(JSON.parse(JSON.stringify(backup)))); // through JSON, as a file would be
  return target;
}

describe('backup and restore', () => {
  it('round-trips every table exactly', async () => {
    const backup = await dumpDatabase();
    const target = restore(backup);
    for (const table of Object.keys(backup.tables)) {
      expect(tableRows(target, table), table).toEqual(tableRows(source, table));
    }
    expect(summarise(backup).ratings).toBe(8);
  });

  it('pages through a table longer than one read, missing nothing', async () => {
    insert(source, 'genre', Array.from({ length: 2345 }, (_, i) => ({ id: `gx-${i}`, name: `genre ${i}`, parent_id: null })));
    const backup = await dumpDatabase();
    expect(backup.tables.genre.rows).toHaveLength(tableRows(source, 'genre').length);
    expect(new Set(backup.tables.genre.rows.map((r) => r[0])).size).toBe(backup.tables.genre.rows.length);
  });

  it('leaves out secrets and derived data', async () => {
    const backup = await dumpDatabase();
    expect(backup.tables.spotify_token).toBeUndefined();
    expect(Object.keys(backup.tables).some((t) => t.startsWith('search_index'))).toBe(false);
    expect(JSON.stringify(backup)).not.toContain('secret');
  });

  it('rebuilds the search index as rows are restored', async () => {
    const target = restore(await dumpDatabase());
    const hit = target.prepare("SELECT entity_id FROM search_index WHERE search_index MATCH '\"sinead\"*'").get();
    expect(hit?.entity_id).toBe('art-q');
  });

  it('refuses to restore over existing data', async () => {
    const backup = await dumpDatabase();
    const target = migratedDb();
    // One unrelated artist: no key would clash, so only the guard can stop it.
    insert(target, 'artist', [{ id: 'unrelated', name: 'Someone', sort_name: 'Someone', source: 'manual' }]);
    expect(() => target.exec(backupToSql(backup))).toThrow(/CHECK constraint failed: n = 0/);
  });

  it('restores the same in parts, even when every part is sent twice', async () => {
    const backup = await dumpDatabase();
    const parts = backupToSqlParts(JSON.parse(JSON.stringify(backup)), keysOf(source), 2_000);
    expect(parts.length).toBeGreaterThan(3);
    const target = migratedDb();
    // Each part is its own transaction, as each wrangler call is; a lost answer means sending it again.
    // Foreign keys checked at once, not deferred, as D1 does across a file: no part may point ahead.
    for (const part of parts) {
      const strict = part.replaceAll('PRAGMA defer_foreign_keys = ON;', '');
      inTransaction(target, strict);
      inTransaction(target, strict);
    }
    for (const table of Object.keys(backup.tables)) {
      expect(tableRows(target, table), table).toEqual(tableRows(source, table));
    }
  });

  it('still refuses existing data when restoring in parts', async () => {
    const backup = await dumpDatabase();
    const target = migratedDb();
    insert(target, 'artist', [{ id: 'unrelated', name: 'Someone', sort_name: 'Someone', source: 'manual' }]);
    expect(() => inTransaction(target, backupToSqlParts(backup, keysOf(source))[0]!)).toThrow(/CHECK constraint failed: n = 0/);
  });

  it('rejects files that are not backups', () => {
    expect(() => backupToSql({ format: 'something else' } as unknown as Backup)).toThrow(/Not a version/);
  });
});

describe('restoreOrder', () => {
  it('puts parents first and polymorphic tables after the catalogue', () => {
    const order = restoreOrder(
      ['rating', 'recording', 'work', 'app_user', 'track', 'release', 'release_group'],
      new Map([
        ['rating', ['app_user']],
        ['recording', ['work']],
        ['work', ['recording']],
        ['track', ['release', 'recording']],
        ['release', ['release_group']],
        ['release_group', ['release']],
      ]),
    );
    const before = (a: string, b: string) => order.indexOf(a) < order.indexOf(b);
    expect(before('app_user', 'rating')).toBe(true);
    expect(before('recording', 'track')).toBe(true);
    expect(before('release', 'track')).toBe(true);
    for (const catalogue of ['recording', 'work', 'release', 'release_group', 'track']) {
      expect(before(catalogue, 'rating'), catalogue).toBe(true);
    }
  });
});
