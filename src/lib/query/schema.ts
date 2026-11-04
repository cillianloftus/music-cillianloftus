/**
 * The definition format (ARCHITECTURE.md §4): one JSON shape for ad-hoc
 * questions and saved playlists alike.
 *
 * This is the security boundary for everything that writes definitions,
 * the language model included. Unknown keys, fields, operators and values
 * of the wrong shape are rejected here, before compile() ever sees them.
 */

import { z } from 'zod';
import { ENTITIES, OPS_BY_TYPE, type Entity, type Field, type Op } from './fields';

export const LIMIT_MAX = 500;
export const LIMIT_PER_GROUP_MAX = 50;
const CONDITIONS_MAX = 24;
const DEPTH_MAX = 4;

export interface Condition {
  field: string;
  op: Op;
  value?: unknown;
}

export type Where = Condition | { and: Where[] } | { or: Where[] };

export interface SortItem {
  field: string;
  dir: 'asc' | 'desc';
}

const OPS = Object.keys(
  Object.fromEntries(Object.values(OPS_BY_TYPE).flat().map((op) => [op, true])),
) as [Op, ...Op[]];

const condition = z
  .object({
    field: z.string().min(1).max(64),
    op: z.enum(OPS),
    value: z.unknown().optional(),
  })
  .strict();

const where: z.ZodType<Where> = z.lazy(() =>
  z.union([
    condition,
    z.object({ and: z.array(where).min(1).max(CONDITIONS_MAX) }).strict(),
    z.object({ or: z.array(where).min(1).max(CONDITIONS_MAX) }).strict(),
  ]),
);

const sortItem = z.object({ field: z.string().min(1).max(64), dir: z.enum(['asc', 'desc']).default('desc') }).strict();

const PARTIAL_DATE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;

/** Checks a condition's value against its field's type. Returns an error or null. */
function checkValue(field: Field, op: Op, value: unknown): string | null {
  if (op === 'is_null' || op === 'is_not_null') {
    return value === undefined ? null : `${op} takes no value`;
  }
  if (value === undefined) return 'needs a value';

  const one = (v: unknown): string | null => {
    switch (field.type) {
      case 'number':
        return typeof v === 'number' && Number.isFinite(v) ? null : 'must be a number';
      case 'date':
        return typeof v === 'string' && PARTIAL_DATE.test(v) ? null : 'must be a date like 2015, 2015-06 or 2015-06-30';
      case 'boolean':
        return typeof v === 'boolean' ? null : 'must be true or false';
      case 'enum':
        return typeof v === 'string' && field.values!.includes(v) ? null : `must be one of ${field.values!.join(', ')}`;
      default:
        return typeof v === 'string' && v.length > 0 && v.length <= 200 ? null : 'must be text';
    }
  };

  if (op === 'between') {
    if (!Array.isArray(value) || value.length !== 2) return 'between takes [low, high]';
    return one(value[0]) ?? one(value[1]);
  }
  if (op === 'in' || op === 'not_in') {
    if (!Array.isArray(value) || value.length === 0 || value.length > 50) return `${op} takes a list of 1 to 50 values`;
    for (const v of value) {
      const error = one(v);
      if (error) return error;
    }
    return null;
  }
  return one(value);
}

/** Walks the where tree checking every condition against the registry. */
function checkWhere(entity: Entity, node: Where, path: (string | number)[], depth: number, ctx: z.RefinementCtx, count: { n: number }) {
  if (depth > DEPTH_MAX) {
    ctx.addIssue({ code: 'custom', path, message: `Conditions nest at most ${DEPTH_MAX} deep.` });
    return;
  }
  if ('and' in node || 'or' in node) {
    const key = 'and' in node ? 'and' : 'or';
    const children = 'and' in node ? node.and : node.or;
    children.forEach((child, i) => checkWhere(entity, child, [...path, key, i], depth + 1, ctx, count));
    return;
  }

  count.n++;
  const field = ENTITIES[entity].fields[node.field];
  if (!field) {
    ctx.addIssue({ code: 'custom', path: [...path, 'field'], message: `Unknown field "${node.field}" for ${entity}.` });
    return;
  }
  if (!OPS_BY_TYPE[field.type].includes(node.op)) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, 'op'],
      message: `"${node.op}" does not apply to ${node.field}. Use one of: ${OPS_BY_TYPE[field.type].join(', ')}.`,
    });
    return;
  }
  const error = checkValue(field, node.op, node.value);
  if (error) ctx.addIssue({ code: 'custom', path: [...path, 'value'], message: `${node.field}: ${error}.` });
}

function checkSort(entity: Entity, items: SortItem[], path: (string | number)[], ctx: z.RefinementCtx) {
  items.forEach((item, i) => {
    const field = ENTITIES[entity].fields[item.field];
    if (!field || !field.sortable || !field.sql) {
      ctx.addIssue({ code: 'custom', path: [...path, i, 'field'], message: `Cannot sort by "${item.field}".` });
    }
  });
}

export const definitionSchema = z
  .object({
    entity: z.enum(['recording', 'release_group', 'artist']),
    where: where.optional(),
    group: z
      .object({
        by: z.string().min(1).max(64),
        limit_per_group: z.number().int().min(1).max(LIMIT_PER_GROUP_MAX),
        sort: z.array(sortItem).min(1).max(4).optional(),
      })
      .strict()
      .optional(),
    sort: z.array(sortItem).min(1).max(4).optional(),
    collapse_by_work: z.boolean().default(true),
    limit: z.number().int().min(1).max(LIMIT_MAX).default(50),
  })
  .strict()
  .superRefine((definition, ctx) => {
    const entity = definition.entity;
    if (definition.where) {
      const count = { n: 0 };
      checkWhere(entity, definition.where, ['where'], 1, ctx, count);
      if (count.n > CONDITIONS_MAX) {
        ctx.addIssue({ code: 'custom', path: ['where'], message: `At most ${CONDITIONS_MAX} conditions.` });
      }
    }
    if (definition.sort) checkSort(entity, definition.sort, ['sort'], ctx);
    if (definition.group) {
      if (!ENTITIES[entity].groups[definition.group.by]) {
        const options = Object.keys(ENTITIES[entity].groups);
        ctx.addIssue({
          code: 'custom',
          path: ['group', 'by'],
          message: options.length
            ? `Cannot group ${entity} by "${definition.group.by}". Use one of: ${options.join(', ')}.`
            : `${entity} results cannot be grouped.`,
        });
      }
      if (definition.group.sort) checkSort(entity, definition.group.sort, ['group', 'sort'], ctx);
    }
  });

export type Definition = z.infer<typeof definitionSchema>;

/** Readable one-line errors for a failed parse. */
export function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
    return `${where}${issue.message}`;
  });
}
