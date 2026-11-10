/**
 * Development only: how many D1 rows each page reads, logged when it has
 * finished streaming, with the dearest statements. D1 bills and caps rows
 * read, so this is the number to watch when a page is changed:
 *
 *   [rows] /artist/… 4,210 rows, 18 statements
 *            2,900  SELECT g.id, g.title …
 *
 * It wraps the binding's prepare and batch. first() is answered through
 * all(), which carries the meta first() drops; the answer is the same.
 * Each request keeps its own count (an AsyncLocalStorage), so a long
 * background fill and the pages loaded while it runs are told apart.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

type Entry = { rows: number; sql: string };
const current = new AsyncLocalStorage<Entry[]>();

const targets = new WeakMap<object, { statement: D1PreparedStatement; sql: string }>();

function record(meta: { rows_read?: number } | undefined, sql: string): void {
  current.getStore()?.push({ rows: meta?.rows_read ?? 0, sql });
}

function wrap(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
  const proxy = new Proxy(statement, {
    get(target, key) {
      if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
      if (key === 'all' || key === 'run') {
        return async () => {
          const result = await target[key]();
          record(result.meta, sql);
          return result;
        };
      }
      if (key === 'first') {
        return async (column?: string) => {
          const result = await target.all<Record<string, unknown>>();
          record(result.meta, sql);
          const row = result.results[0] ?? null;
          return column === undefined ? row : row ? (row[column] ?? null) : null;
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  targets.set(proxy, { statement, sql });
  return proxy;
}

let installed = false;

/** Wraps the binding once. */
export function meterRows(db: D1Database): void {
  if (installed) return;
  installed = true;
  const prepare = db.prepare.bind(db);
  const batch = db.batch.bind(db);
  db.prepare = (sql: string) => wrap(prepare(sql), sql);
  db.batch = async <T = unknown>(statements: D1PreparedStatement[]) => {
    const results = await batch<T>(statements.map((s) => targets.get(s)?.statement ?? s));
    results.forEach((result, i) => record(result.meta, `(batch) ${targets.get(statements[i]!)?.sql ?? ''}`));
    return results;
  };
}

/** Runs a request with a count of its own; report logs what it has read so far. */
export function counted<T>(fn: (report: (label: string) => void) => T): T {
  const mine: Entry[] = [];
  const report = (label: string) => {
    const total = mine.reduce((n, e) => n + e.rows, 0);
    const top = [...mine].sort((a, b) => b.rows - a.rows).slice(0, label.includes('(cold)') ? 14 : 3);
    const lines = top
      .filter((e) => e.rows > 0)
      .map((e) => `           ${String(e.rows).padStart(8)}  ${e.sql.replace(/\s+/g, ' ').trim().slice(0, 110)}`);
    console.log([`[rows] ${label} ${total.toLocaleString('en-GB')} rows, ${mine.length} statements`, ...lines].join('\n'));
  };
  return current.run(mine, () => fn(report));
}

/** The response, reporting once its body has been read to the end. */
export function reportWhenDone(response: Response, report: () => void): Response {
  if (!response.body) {
    report();
    return response;
  }
  const done = new TransformStream({ flush: () => report() });
  return new Response(response.body.pipeThrough(done), response);
}
