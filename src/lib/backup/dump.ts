/**
 * Dumps the live database into the backup format. Read-only.
 */

import { env } from 'cloudflare:workers';
import { BACKUP_FORMAT, BACKUP_VERSION, isExcluded, restoreOrder, type Backup, type TableDump } from './format';

const PAGE = 1000;

async function dumpTable(table: string): Promise<TableDump> {
  const { results: info } = await env.DB.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
    .bind(table)
    .all<{ name: string }>();
  const columns = info.map((c) => c.name);

  const rows: unknown[][] = [];
  // Paged from the last rowid seen, not by OFFSET: SQLite reads every row an
  // offset skips, and D1 counts them, so a 58,000-row table cost 1.7 million
  // rows read that way. This reads each row once.
  for (let after = Number.MIN_SAFE_INTEGER; ; ) {
    // Table names come from sqlite_master, never from input.
    const { results } = await env.DB.prepare(`SELECT rowid AS "__rowid", * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ?`)
      .bind(after, PAGE)
      .all<Record<string, unknown>>();
    rows.push(...results.map((row) => columns.map((c) => row[c] ?? null)));
    if (results.length < PAGE) break;
    after = Number(results[results.length - 1].__rowid);
  }
  return { columns, rows };
}

export async function dumpDatabase(): Promise<Backup> {
  const { results: master } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all<{ name: string }>();
  const tables = master.map((t) => t.name).filter((name) => !isExcluded(name));

  const foreignKeys = new Map<string, string[]>();
  for (const table of tables) {
    const { results } = await env.DB.prepare('SELECT "table" AS parent FROM pragma_foreign_key_list(?)')
      .bind(table)
      .all<{ parent: string }>();
    foreignKeys.set(table, results.map((r) => r.parent));
  }

  let migrations: string[] = [];
  try {
    const { results } = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>();
    migrations = results.map((m) => m.name);
  } catch {
    // Databases built outside Wrangler (tests) have no migrations table.
  }

  const dumps: Record<string, TableDump> = {};
  for (const table of tables) dumps[table] = await dumpTable(table);

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    created_at: new Date().toISOString(),
    migrations,
    restore_order: restoreOrder(tables, foreignKeys),
    tables: dumps,
  };
}
