/**
 * The slice of the D1 API this codebase uses, over node:sqlite, so code
 * that talks to env.DB can be tested against the real migrations.
 *
 * batch() runs in a transaction and rolls back on error, as D1 does.
 */

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

function toSql(value: unknown): SQLInputValue {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value as SQLInputValue;
}

class Statement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private readonly params: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): Statement {
    return new Statement(this.db, this.sql, values.map(toSql));
  }

  rows(): Record<string, unknown>[] {
    return this.db.prepare(this.sql).all(...this.params) as Record<string, unknown>[];
  }

  async all<T>() {
    return { results: this.rows() as T[], success: true, meta: {} };
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }

  async run() {
    const result = this.db.prepare(this.sql).run(...this.params);
    return { results: [], success: true, meta: { changes: Number(result.changes) } };
  }
}

export function d1(db: DatabaseSync): D1Database {
  const database = {
    prepare: (sql: string) => new Statement(db, sql),
    async batch(statements: Statement[]) {
      db.exec('BEGIN');
      try {
        const results = statements.map((statement) => ({ results: statement.rows(), success: true, meta: {} }));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return database as unknown as D1Database;
}
