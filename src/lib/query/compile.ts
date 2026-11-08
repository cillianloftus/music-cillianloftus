/**
 * compile(definition) -> { sql, params }
 *
 * The one compiler behind every caller: the query endpoint, a saved
 * definition's page, and the Spotify push (ARCHITECTURE.md §4). Identical
 * input gives identical SQL, so a pushed playlist always contains exactly
 * what the preview showed.
 *
 * It emits a single SELECT and has no code path that produces anything
 * else. SQL text comes only from this file and the field registry; every
 * value from the definition is a bound parameter. The definition must
 * already have passed definitionSchema.
 *
 * Shape of the output, for a recording definition:
 *
 *   WITH params AS (SELECT ? AS user_id),
 *   base AS (    -- rows passing `where`, with sort and group keys
 *   ranked AS (  -- collapse_by_work: one recording per work
 *   grouped AS ( -- top N per group
 *   SELECT id FROM grouped ... ORDER BY ... LIMIT ?
 */

import { DEFAULT_SORT, ENTITIES, type EntitySpec, type Field } from './fields';
import type { Condition, Definition, SortItem, Where } from './schema';

export interface CompileOptions {
  /** Whose ratings and plays the scores come from. */
  userId: string | null;
  /** Saved-definition overrides (recordings only). Pins bypass filters; excludes always win. */
  pins?: string[];
  excludes?: string[];
}

export interface Compiled {
  sql: string;
  params: unknown[];
}

class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return '?';
  }
}

/** A genre by name, or by a name it had before a rename (0035), so saved definitions keep working. */
const GENRE_BY_NAME = (p: Params, value: unknown) =>
  `SELECT id FROM genre WHERE name = ${p.add(value)} UNION SELECT genre_id FROM genre_alias WHERE name = ${p.add(value)}`;

const GENRE_TREE = (p: Params, value: unknown) => `
  WITH RECURSIVE tree(id) AS (
    ${GENRE_BY_NAME(p, value)}
    UNION
    -- Every parent link, primary or not (0013): blues rock counts under blues too.
    SELECT e.genre_id FROM v_genre_edge e JOIN tree ON e.parent_id = tree.id
  )
  SELECT id FROM tree`;

/** A date field compared with a partial date ('2015', '2015-06') at that precision. */
function dateCondition(expr: string, op: Condition['op'], value: unknown, p: Params): string {
  const prefix = (v: string) => `substr(${expr}, 1, ${v.length})`;
  switch (op) {
    case 'eq': {
      const v = value as string;
      return `${prefix(v)} = ${p.add(v)}`;
    }
    case 'gt':
    case 'lte': {
      // "after 2015" excludes all of 2015; "up to 2015" includes all of it.
      const v = value as string;
      return `${prefix(v)} ${op === 'gt' ? '>' : '<='} ${p.add(v)}`;
    }
    case 'gte':
      return `${expr} >= ${p.add(value)}`;
    case 'lt':
      return `${expr} < ${p.add(value)}`;
    case 'between': {
      const [low, high] = value as [string, string];
      return `(${expr} >= ${p.add(low)} AND ${prefix(high)} <= ${p.add(high)})`;
    }
    default:
      return nullCheck(expr, op);
  }
}

function nullCheck(expr: string, op: Condition['op']): string {
  return op === 'is_null' ? `${expr} IS NULL` : `${expr} IS NOT NULL`;
}

const COMPARISON: Record<string, string> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

function listParam(values: unknown[], p: Params): string {
  return `(SELECT value FROM json_each(${p.add(JSON.stringify(values))}))`;
}

function creditCondition(spec: EntitySpec, field: Field, op: Condition['op'], value: unknown, p: Params): string {
  const scope = field.credit!.deep ? spec.deepCredit : spec.ownCredit;
  const roles = field.credit!.roles.map((role) => `'${role}'`).join(', ');
  let match: string;
  switch (op) {
    case 'eq':
      match = `a.name = ${p.add(value)} COLLATE NOCASE`;
      break;
    case 'contains':
      match = `instr(lower(a.name), lower(${p.add(value)})) > 0`;
      break;
    default: // in, not_in
      match = `lower(a.name) IN (SELECT lower(value) FROM json_each(${p.add(JSON.stringify(value))}))`;
  }
  const exists = `EXISTS (
    SELECT 1 FROM artist_credit c JOIN artist a ON a.id = c.artist_id
    WHERE ${scope} AND c.role IN (${roles}) AND ${match})`;
  return op === 'not_in' ? `NOT ${exists}` : exists;
}

function genreCondition(spec: EntitySpec, op: Condition['op'], value: unknown, p: Params): string {
  let genres: string;
  if (op === 'in_tree') genres = GENRE_TREE(p, value);
  else if (op === 'eq') genres = GENRE_BY_NAME(p, value);
  else {
    const names = JSON.stringify(value);
    genres = `SELECT id FROM genre WHERE lower(name) IN (SELECT lower(value) FROM json_each(${p.add(names)}))
      UNION SELECT genre_id FROM genre_alias WHERE lower(name) IN (SELECT lower(value) FROM json_each(${p.add(names)}))`;
  }
  return spec.genre!.replace('{genres}', genres);
}

function compileCondition(spec: EntitySpec, condition: Condition, p: Params): string {
  const field = spec.fields[condition.field]!;
  const { op, value } = condition;

  if (field.type === 'genre') return genreCondition(spec, op, value, p);
  if (field.type === 'credit') return creditCondition(spec, field, op, value, p);

  const expr = field.sql!;
  if (op === 'is_null' || op === 'is_not_null') return nullCheck(expr, op);
  if (field.type === 'date') return dateCondition(expr, op, value, p);

  switch (op) {
    case 'contains':
      return `instr(lower(${expr}), lower(${p.add(value)})) > 0`;
    case 'in':
      return `${expr} IN ${listParam(value as unknown[], p)}`;
    case 'not_in':
      return `${expr} NOT IN ${listParam(value as unknown[], p)}`;
    case 'between': {
      const [low, high] = value as [unknown, unknown];
      return `${expr} BETWEEN ${p.add(low)} AND ${p.add(high)}`;
    }
    default: {
      const bound = field.type === 'boolean' ? (value ? 1 : 0) : value;
      const collate = field.type === 'text' ? ' COLLATE NOCASE' : '';
      return `${expr} ${COMPARISON[op]} ${p.add(bound)}${collate}`;
    }
  }
}

function compileWhere(spec: EntitySpec, node: Where, p: Params): string {
  if ('and' in node) return `(${node.and.map((child) => compileWhere(spec, child, p)).join(' AND ')})`;
  if ('or' in node) return `(${node.or.map((child) => compileWhere(spec, child, p)).join(' OR ')})`;
  return compileCondition(spec, node, p);
}

/** ORDER BY terms over aliased key columns, nulls always last. */
function orderBy(keys: { alias: string; dir: 'asc' | 'desc' }[]): string {
  return [...keys.flatMap(({ alias, dir }) => [`${alias} IS NULL`, `${alias} ${dir.toUpperCase()}`]), 'id'].join(', ');
}

export function compile(definition: Definition, options: CompileOptions): Compiled {
  const spec = ENTITIES[definition.entity];
  const p = new Params();
  const userParam = p.add(options.userId);

  const sort: SortItem[] = definition.sort ?? DEFAULT_SORT[definition.entity];
  const groupSort: SortItem[] = definition.group?.sort ?? sort;
  const collapse = definition.entity === 'recording' && definition.collapse_by_work && spec.work;

  // Key columns carried through the pipeline.
  const columns: string[] = ['e.id AS id'];
  const sortKeys = sort.map((item, i) => {
    columns.push(`${spec.fields[item.field]!.sql} AS sort_${i}`);
    return { alias: `sort_${i}`, dir: item.dir };
  });
  const groupKeys = groupSort.map((item, i) => {
    columns.push(`${spec.fields[item.field]!.sql} AS group_sort_${i}`);
    return { alias: `group_sort_${i}`, dir: item.dir };
  });
  if (definition.group) columns.push(`${spec.groups[definition.group.by]!.sql} AS group_key`);
  if (collapse) {
    columns.push(`coalesce(${spec.work}, e.id) AS work_key`);
    columns.push(`(SELECT w.preferred_recording_id FROM work w WHERE w.id = ${spec.work}) = e.id AS preferred`);
    columns.push(`${spec.fields.personal_score!.sql} AS work_score`);
  }

  // WHERE: the definition's filters, then pins and excludes.
  let filter = definition.where ? compileWhere(spec, definition.where, p) : '1';
  if (definition.entity === 'recording' && options.pins?.length) {
    filter = `(${filter} OR e.id IN ${listParam(options.pins, p)})`;
  }
  if (definition.entity === 'recording' && options.excludes?.length) {
    filter = `${filter} AND e.id NOT IN ${listParam(options.excludes, p)}`;
  }

  const ctes = [
    `params AS (SELECT ${userParam} AS user_id)`,
    `base AS (SELECT ${columns.join(', ')} ${spec.from} WHERE ${filter})`,
  ];

  let source = 'base';
  if (collapse) {
    ctes.push(`ranked AS (
      SELECT *, row_number() OVER (
        PARTITION BY work_key
        ORDER BY preferred IS NOT 1, work_score IS NULL, work_score DESC, id
      ) AS work_rank
      FROM base)`);
    ctes.push(`collapsed AS (SELECT * FROM ranked WHERE work_rank = 1)`);
    source = 'collapsed';
  }

  let groupFilter = '';
  if (definition.group) {
    ctes.push(`grouped AS (
      SELECT *, row_number() OVER (PARTITION BY group_key ORDER BY ${orderBy(groupKeys)}) AS group_rank
      FROM ${source})`);
    source = 'grouped';
    groupFilter = `WHERE group_rank <= ${p.add(definition.group.limit_per_group)}`;
  }

  const sql = `WITH ${ctes.join(',\n')}
SELECT id FROM ${source} ${groupFilter}
ORDER BY ${orderBy(sortKeys)}
LIMIT ${p.add(definition.limit)}`;

  return { sql, params: p.values };
}
