/**
 * Dumps the live database into the backup format. Read-only.
 *
 * Written out as text a page of rows at a time (backupText), never held
 * whole: a Worker has 128 MB, and the library outgrew it on 10 Nov 2026.
 * The whole-database JSON string, the row arrays behind it and gzip's
 * copy went past the limit, the Worker was cut off without an error, and
 * the queue started the backup again every fifteen minutes, reading the
 * whole database each time (50 million rows in a day).
 */

import { env } from 'cloudflare:workers';
import { BACKUP_FORMAT, BACKUP_VERSION, isExcluded, restoreOrder, type Backup, type BackupSummary } from './format';

const PAGE = 1000;

/** Each page of a table's rows, values in column order. */
async function* tablePages(table: string, columns: string[]): AsyncGenerator<unknown[][]> {
  // Paged from the last rowid seen, not by OFFSET: SQLite reads every row an
  // offset skips, and D1 counts them, so a 58,000-row table cost 1.7 million
  // rows read that way. This reads each row once.
  for (let after = Number.MIN_SAFE_INTEGER; ; ) {
    // Table names come from sqlite_master, never from input.
    const { results } = await env.DB.prepare(`SELECT rowid AS "__rowid", * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ?`)
      .bind(after, PAGE)
      .all<Record<string, unknown>>();
    yield results.map((row) => columns.map((c) => row[c] ?? null));
    if (results.length < PAGE) return;
    after = Number(results[results.length - 1]!.__rowid);
  }
}

/**
 * The backup as JSON text, in pieces: the same document JSON.stringify
 * would make of a Backup, so restoring reads either. `summary` is filled
 * in as the pieces go by and is complete once they have all been taken.
 */
export async function backupText(): Promise<{ created_at: string; migrations: string[]; summary: BackupSummary; pieces: AsyncGenerator<string> }> {
  const { results: master } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all<{ name: string }>();
  const tables = master.map((t) => t.name).filter((name) => !isExcluded(name));

  const foreignKeys = new Map<string, string[]>();
  const columns = new Map<string, string[]>();
  for (const table of tables) {
    const [fk, info] = await Promise.all([
      env.DB.prepare('SELECT "table" AS parent FROM pragma_foreign_key_list(?)').bind(table).all<{ parent: string }>(),
      env.DB.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').bind(table).all<{ name: string }>(),
    ]);
    foreignKeys.set(table, fk.results.map((r) => r.parent));
    columns.set(table, info.results.map((c) => c.name));
  }

  let migrations: string[] = [];
  try {
    const { results } = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>();
    migrations = results.map((m) => m.name);
  } catch {
    // Databases built outside Wrangler (tests) have no migrations table.
  }

  const created_at = new Date().toISOString();
  const summary: BackupSummary = { tables: tables.length, rows: 0, ratings: 0 };
  const head = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    created_at,
    migrations,
    restore_order: restoreOrder(tables, foreignKeys),
  };

  async function* pieces(): AsyncGenerator<string> {
    yield `${JSON.stringify(head).slice(0, -1)},"tables":{`;
    for (const [t, table] of tables.entries()) {
      const cols = columns.get(table)!;
      yield `${t ? ',' : ''}${JSON.stringify(table)}:{"columns":${JSON.stringify(cols)},"rows":[`;
      let first = true;
      for await (const rows of tablePages(table, cols)) {
        if (rows.length === 0) continue;
        summary.rows += rows.length;
        if (table === 'rating') summary.ratings += rows.length;
        yield `${first ? '' : ','}${rows.map((row) => JSON.stringify(row)).join(',')}`;
        first = false;
      }
      yield ']}';
    }
    yield '}}';
  }

  return { created_at, migrations, summary, pieces: pieces() };
}

/** The whole backup as one object: for tests and small databases. */
export async function dumpDatabase(): Promise<Backup> {
  const { pieces } = await backupText();
  let text = '';
  for await (const piece of pieces) text += piece;
  return JSON.parse(text) as Backup;
}
