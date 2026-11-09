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
 * Requests running at once share the count, which is fine for a dev
 * server driven one page at a time.
 */

type Entry = { rows: number; sql: string };
let log: Entry[] = [];

const targets = new WeakMap<object, D1PreparedStatement>();

function record(meta: { rows_read?: number } | undefined, sql: string): void {
  log.push({ rows: meta?.rows_read ?? 0, sql });
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
  targets.set(proxy, statement);
  return proxy;
}

let installed = false;

/** Wraps the binding once. */
export function meterRows(db: D1Database): void {
  if (installed) return;
  installed = true;
  const prepare = db.prepare.bind(db);
  const batch = db.batch.bind(db);
  const sqlOf = new WeakMap<object, string>();
  db.prepare = (sql: string) => {
    const statement = wrap(prepare(sql), sql);
    sqlOf.set(statement, sql);
    return statement;
  };
  db.batch = async <T = unknown>(statements: D1PreparedStatement[]) => {
    const results = await batch<T>(statements.map((s) => targets.get(s) ?? s));
    results.forEach((result, i) => record(result.meta, sqlOf.get(statements[i]!) ?? '(batch)'));
    return results;
  };
}

/** Starts counting for a request; the returned function reports it. */
export function startCount(): (label: string) => void {
  const from = log.length;
  return (label) => {
    const mine = log.slice(from);
    const total = mine.reduce((n, e) => n + e.rows, 0);
    const top = [...mine].sort((a, b) => b.rows - a.rows).slice(0, 3);
    const lines = top
      .filter((e) => e.rows > 0)
      .map((e) => `           ${String(e.rows).padStart(8)}  ${e.sql.replace(/\s+/g, ' ').trim().slice(0, 110)}`);
    console.log([`[rows] ${label} ${total.toLocaleString('en-GB')} rows, ${mine.length} statements`, ...lines].join('\n'));
    if (log.length > 5_000) log = log.slice(-1_000);
  };
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
