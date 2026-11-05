/**
 * The backup format (ARCHITECTURE.md §10): every table as JSON, readable
 * without this codebase, and the SQL to restore it.
 *
 * Self-contained on purpose (no imports), so the restore script can run it
 * directly under Node when nothing else in the stack is available.
 */

export const BACKUP_FORMAT = 'music-cillianloftus/backup';
export const BACKUP_VERSION = 1;

export interface TableDump {
  columns: string[];
  /** One array per row, values in `columns` order. */
  rows: unknown[][];
}

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  created_at: string;
  /** Migrations applied to the source database; a restore target must match. */
  migrations: string[];
  /** Tables in an order that satisfies foreign keys and entity triggers. */
  restore_order: string[];
  tables: Record<string, TableDump>;
}

/**
 * Tables a backup leaves out: SQLite and D1 internals, the search index
 * (derived, and rebuilt by its triggers as rows are restored), Spotify
 * tokens and pasted API keys (secrets; reconnecting is quick).
 */
export function isExcluded(table: string): boolean {
  return (
    table.startsWith('sqlite_') ||
    table.startsWith('_cf_') ||
    table === 'd1_migrations' ||
    table.startsWith('search_index') ||
    table === 'spotify_token' ||
    // Pasted API keys: secrets too.
    table === 'connection_secret'
  );
}

/** Tables the migrations fill with built-in rows (credit roles). */
const SEEDED = new Set(['credit_role']);

/** Tables whose insert triggers check that a polymorphic entity exists. */
const POLYMORPHIC = ['artist_credit', 'genre_tag', 'rating'];
const CATALOGUE = ['artist', 'work', 'recording', 'release_group', 'release', 'track', 'genre'];

/**
 * Orders tables so parents come before children. Foreign keys are deferred
 * during a restore, so cycles (work <-> recording) are broken arbitrarily;
 * but the entity-existence triggers fire immediately, so polymorphic tables
 * are placed after the whole catalogue.
 */
export function restoreOrder(tables: string[], foreignKeys: Map<string, string[]>): string[] {
  const present = new Set(tables);
  const deps = new Map<string, Set<string>>();
  for (const table of tables) {
    const parents = new Set((foreignKeys.get(table) ?? []).filter((p) => p !== table && present.has(p)));
    if (POLYMORPHIC.includes(table)) for (const c of CATALOGUE) if (present.has(c)) parents.add(c);
    deps.set(table, parents);
  }

  const order: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (table: string) => {
    if (state.get(table)) return; // done, or a cycle: deferred FKs cover it
    state.set(table, 'visiting');
    for (const parent of [...deps.get(table)!].sort()) visit(parent);
    state.set(table, 'done');
    order.push(table);
  };
  for (const table of [...tables].sort()) visit(table);
  return order;
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Cannot restore non-finite number ${value}`);
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  throw new Error(`Cannot restore value of type ${typeof value}`);
}

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

const ROWS_PER_INSERT = 100;

/** A table's keys, read from the target schema. */
export interface TableKeys {
  primaryKey: string[];
  /** Columns that may hold NULL. */
  nullable: string[];
  foreignKeys: Array<{ parent: string; columns: string[] }>;
}
export type SchemaKeys = Map<string, TableKeys>;

/**
 * Reads every table's keys through a SQLite query function (node:sqlite in
 * the restore script and tests), so this module stays dependency-free.
 */
export function readKeys(all: (sql: string, ...params: string[]) => unknown[]): SchemaKeys {
  const keys: SchemaKeys = new Map();
  const tables = all(`SELECT name FROM sqlite_master WHERE type = 'table'`) as Array<{ name: string }>;
  for (const { name } of tables) {
    const info = all(`SELECT name, pk, "notnull" AS required FROM pragma_table_info(?)`, name) as Array<{ name: string; pk: number; required: number }>;
    const fks = all(`SELECT id, "table" AS parent, "from" AS col FROM pragma_foreign_key_list(?)`, name) as Array<{ id: number; parent: string; col: string }>;
    const byId = new Map<number, { parent: string; columns: string[] }>();
    for (const fk of fks) {
      const entry = byId.get(fk.id) ?? { parent: fk.parent, columns: [] };
      entry.columns.push(fk.col);
      byId.set(fk.id, entry);
    }
    keys.set(name, {
      primaryKey: info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name),
      nullable: info.filter((c) => !c.required && c.pk === 0).map((c) => c.name),
      foreignKeys: [...byId.values()],
    });
  }
  return keys;
}

/**
 * Columns that point forward in restore order (at a table restored later,
 * or at their own table) and can be left empty: a part loads them as NULL
 * and fills them in once what they point at is in, so no row ever refers
 * to one that is not there yet. D1 does not reliably hold deferred foreign
 * keys open across a file, so a part must not need them.
 */
function forwardColumns(order: string[], keys: SchemaKeys): Map<string, string[]> {
  const forward = new Map<string, string[]>();
  order.forEach((table, i) => {
    const k = keys.get(table);
    if (!k) return;
    for (const fk of k.foreignKeys) {
      if (order.indexOf(fk.parent) < i) continue;
      // Of a composite key, the columns that are not the row's own identity.
      const cols = fk.columns.filter((c) => !k.primaryKey.includes(c));
      if (cols.length > 0 && cols.every((c) => k.nullable.includes(c))) {
        forward.set(table, [...new Set([...(forward.get(table) ?? []), ...cols])]);
      }
    }
  });
  return forward;
}

/** The restore as statements: the emptiness guard, then each table's rows in restore order. */
function restoreStatements(backup: Backup, verbFor: (table: string) => string, keys?: SchemaKeys) {
  if (backup.format !== BACKUP_FORMAT || backup.version !== BACKUP_VERSION) {
    throw new Error(`Not a version ${BACKUP_VERSION} ${BACKUP_FORMAT} file.`);
  }

  const header = [
    '-- Restore of a music-cillianloftus backup taken ' + backup.created_at,
    'PRAGMA defer_foreign_keys = ON;',
    'CREATE TABLE _restore_guard (n INTEGER NOT NULL CHECK (n = 0));',
    'INSERT INTO _restore_guard SELECT (SELECT count(*) FROM rating) + (SELECT count(*) FROM release_group) + (SELECT count(*) FROM artist);',
    'DROP TABLE _restore_guard;',
  ];
  const inserts: string[] = [];
  const tableOf: string[] = [];
  const forward = keys ? forwardColumns(backup.restore_order, keys) : new Map<string, string[]>();
  // UPDATEs that fill a forward column, waiting on the table they point at.
  const waiting = new Map<string, string[]>();

  for (const table of backup.restore_order) {
    const dump = backup.tables[table];
    if (dump && dump.rows.length > 0) {
      const columns = dump.columns.map(ident).join(', ');
      const later = new Set((forward.get(table) ?? []).map((c) => dump.columns.indexOf(c)).filter((i) => i >= 0));
      for (let i = 0; i < dump.rows.length; i += ROWS_PER_INSERT) {
        const values = dump.rows
          .slice(i, i + ROWS_PER_INSERT)
          .map((row) => `(${row.map((v, c) => (later.has(c) ? 'NULL' : literal(v))).join(', ')})`)
          .join(',\n  ');
        inserts.push(`${verbFor(table)} INTO ${ident(table)} (${columns}) VALUES\n  ${values};`);
        tableOf.push(table);
      }
      if (later.size > 0) {
        const pk = keys!.get(table)!.primaryKey;
        for (const fk of keys!.get(table)!.foreignKeys) {
          const cols = fk.columns.filter((c) => (forward.get(table) ?? []).includes(c));
          if (cols.length === 0) continue;
          for (const row of dump.rows) {
            const at = (c: string) => row[dump.columns.indexOf(c)];
            if (cols.every((c) => at(c) === null || at(c) === undefined)) continue;
            const set = cols.map((c) => `${ident(c)} = ${literal(at(c))}`).join(', ');
            const where = pk.map((c) => `${ident(c)} = ${literal(at(c))}`).join(' AND ');
            const list = waiting.get(fk.parent) ?? [];
            list.push(`UPDATE ${ident(table)} SET ${set} WHERE ${where};`);
            waiting.set(fk.parent, list);
          }
        }
      }
    }
    for (const update of waiting.get(table) ?? []) {
      inserts.push(update);
      tableOf.push(table);
    }
    waiting.delete(table);
  }
  return { header, inserts, tableOf };
}

/**
 * SQL that restores a backup into a freshly migrated, empty database.
 * A guard aborts if the catalogue or ratings already hold data, so a
 * restore can never merge into or duplicate a live library.
 */
export function backupToSql(backup: Backup): string {
  // Built-in rows a migration already seeded are replaced by the backup's.
  const { header, inserts } = restoreStatements(backup, (t) => (SEEDED.has(t) ? 'INSERT OR REPLACE' : 'INSERT'));
  return [...header, ...inserts].join('\n') + '\n';
}

/**
 * The same restore cut into parts of about `maxBytes`, for a remote
 * database over a connection that may drop. Each part is its own
 * transaction and safe to send twice: rows go in with INSERT OR IGNORE and
 * forward references are filled by UPDATE, so a part that landed before its
 * answer was lost changes nothing the second time. The emptiness guard is
 * the first part on its own (it writes nothing). Tables go in restore
 * order and forward references are loaded empty then filled in (see
 * `forwardColumns`), so every part stands on what is already committed.
 */
export function backupToSqlParts(backup: Backup, keys: SchemaKeys, maxBytes = 1_500_000): string[] {
  const { header, inserts } = restoreStatements(backup, (t) => (SEEDED.has(t) ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE'), keys);
  const parts = [header.join('\n') + '\n'];
  const start = 'PRAGMA defer_foreign_keys = ON;\n';
  let current = start;
  for (const statement of inserts) {
    if (current !== start && current.length + statement.length > maxBytes) {
      parts.push(current);
      current = start;
    }
    current += statement + '\n';
  }
  if (current !== start) parts.push(current);
  return parts;
}

export interface BackupSummary {
  tables: number;
  rows: number;
  ratings: number;
}

export function summarise(backup: Backup): BackupSummary {
  const dumps = Object.values(backup.tables);
  return {
    tables: dumps.length,
    rows: dumps.reduce((sum, t) => sum + t.rows.length, 0),
    ratings: backup.tables.rating?.rows.length ?? 0,
  };
}
