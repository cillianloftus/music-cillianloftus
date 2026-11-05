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
 * (derived, and rebuilt by its triggers as rows are restored) and Spotify
 * tokens (secrets; reconnecting is one click).
 */
export function isExcluded(table: string): boolean {
  return (
    table.startsWith('sqlite_') ||
    table.startsWith('_cf_') ||
    table === 'd1_migrations' ||
    table.startsWith('search_index') ||
    table === 'spotify_token'
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

/**
 * SQL that restores a backup into a freshly migrated, empty database.
 * A guard aborts if the catalogue or ratings already hold data, so a
 * restore can never merge into or duplicate a live library.
 */
export function backupToSql(backup: Backup): string {
  if (backup.format !== BACKUP_FORMAT || backup.version !== BACKUP_VERSION) {
    throw new Error(`Not a version ${BACKUP_VERSION} ${BACKUP_FORMAT} file.`);
  }

  const lines = [
    '-- Restore of a music-cillianloftus backup taken ' + backup.created_at,
    'PRAGMA defer_foreign_keys = ON;',
    'CREATE TABLE _restore_guard (n INTEGER NOT NULL CHECK (n = 0));',
    'INSERT INTO _restore_guard SELECT (SELECT count(*) FROM rating) + (SELECT count(*) FROM release_group) + (SELECT count(*) FROM artist);',
    'DROP TABLE _restore_guard;',
  ];

  for (const table of backup.restore_order) {
    const dump = backup.tables[table];
    if (!dump || dump.rows.length === 0) continue;
    const columns = dump.columns.map(ident).join(', ');
    for (let i = 0; i < dump.rows.length; i += ROWS_PER_INSERT) {
      const values = dump.rows
        .slice(i, i + ROWS_PER_INSERT)
        .map((row) => `(${row.map(literal).join(', ')})`)
        .join(',\n  ');
      // Built-in rows a migration already seeded are replaced by the backup's.
      const verb = SEEDED.has(table) ? 'INSERT OR REPLACE' : 'INSERT';
      lines.push(`${verb} INTO ${ident(table)} (${columns}) VALUES\n  ${values};`);
    }
  }
  return lines.join('\n') + '\n';
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
