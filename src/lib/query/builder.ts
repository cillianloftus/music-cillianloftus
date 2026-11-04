/**
 * The filter-chip builder's editing operations (build step 8).
 *
 * The builder's whole state is a definition carried in the URL, so every
 * edit is a pure function from one definition to the next, the browser's
 * history is the undo stack, and every state can be shared or bookmarked.
 * Output always goes back through definitionSchema before it runs.
 */

import { DEFAULT_SORT, ENTITIES, OPS_BY_TYPE, type Entity, type Field, type Op } from './fields';
import { definitionSchema, type Condition, type Definition, type SortItem } from './schema';

/** URL-safe base64 of the definition's JSON. */
export function encodeDefinition(definition: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(definition));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeDefinition(encoded: string): unknown {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function starterDefinition(entity: Entity): Definition {
  return definitionSchema.parse({ entity });
}

/**
 * The top-level conditions as chips, or null when the where clause uses
 * OR or nesting, which the chip builder shows read-only.
 */
export function chipConditions(definition: Definition): Condition[] | null {
  const where = definition.where;
  if (!where) return [];
  if ('field' in where) return [where];
  if ('and' in where && where.and.every((c) => 'field' in c)) return where.and as Condition[];
  return null;
}

function withConditions(definition: Definition, conditions: Condition[]): Definition {
  const { where: _where, ...rest } = definition;
  return conditions.length === 0 ? (rest as Definition) : { ...rest, where: { and: conditions } };
}

export function addCondition(definition: Definition, condition: Condition): Definition {
  return withConditions(definition, [...(chipConditions(definition) ?? []), condition]);
}

export function replaceCondition(definition: Definition, index: number, condition: Condition): Definition {
  const conditions = [...(chipConditions(definition) ?? [])];
  conditions[index] = condition;
  return withConditions(definition, conditions);
}

export function removeCondition(definition: Definition, index: number): Definition {
  return withConditions(definition, (chipConditions(definition) ?? []).filter((_, i) => i !== index));
}

/** Switching entity drops everything field-specific: fields differ per entity. */
export function switchEntity(definition: Definition, entity: Entity): Definition {
  return definition.entity === entity ? definition : { ...starterDefinition(entity), limit: definition.limit };
}

export interface ShapeInput {
  sort?: string | null;
  dir?: string | null;
  limit?: string | null;
  groupBy?: string | null;
  perGroup?: string | null;
  collapse?: string | null;
}

export function withShape(definition: Definition, input: ShapeInput): Definition {
  const next: Definition = { ...definition };
  if (input.sort) {
    const sort: SortItem = { field: input.sort, dir: input.dir === 'asc' ? 'asc' : 'desc' };
    next.sort = [sort];
  }
  if (input.limit) next.limit = Number(input.limit);
  if (input.groupBy !== undefined) {
    if (input.groupBy) next.group = { by: input.groupBy, limit_per_group: Number(input.perGroup || 5) };
    else delete next.group;
  }
  if (input.collapse !== undefined) next.collapse_by_work = input.collapse === 'on';
  return next;
}

export function currentSort(definition: Definition): SortItem {
  return (definition.sort ?? DEFAULT_SORT[definition.entity])[0]!;
}

/** Operators in the order the builder offers them, with plain labels. */
export const OP_LABELS: Record<Op, string> = {
  eq: 'is',
  neq: 'is not',
  gt: 'more than',
  gte: 'at least',
  lt: 'less than',
  lte: 'at most',
  between: 'between',
  in: 'is any of',
  not_in: 'is none of',
  contains: 'contains',
  in_tree: 'is or is under',
  is_null: 'is empty',
  is_not_null: 'is set',
};

export const DATE_OP_LABELS: Partial<Record<Op, string>> = {
  eq: 'in',
  gt: 'after',
  gte: 'from',
  lt: 'before',
  lte: 'up to',
  between: 'between',
};

export function opsFor(field: Field): Op[] {
  return [...OPS_BY_TYPE[field.type]];
}

export function opLabel(field: Field, op: Op): string {
  return (field.type === 'date' ? DATE_OP_LABELS[op] : undefined) ?? OP_LABELS[op];
}

const list = (raw: string) =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Turns the condition form (strings, as submitted) into a typed condition.
 * Whatever it produces is validated by definitionSchema afterwards; this
 * only does the conversions a form cannot.
 */
export function conditionFromForm(
  entity: Entity,
  fieldKey: string,
  op: string,
  value: string,
  valueTo: string,
): Condition | string {
  const field = ENTITIES[entity].fields[fieldKey];
  if (!field) return `Unknown field "${fieldKey}".`;
  if (!OPS_BY_TYPE[field.type].includes(op as Op)) return `Choose how to compare ${field.label.toLowerCase()}.`;
  const typedOp = op as Op;

  if (typedOp === 'is_null' || typedOp === 'is_not_null') return { field: fieldKey, op: typedOp };

  const convert = (raw: string): unknown => {
    if (field.type === 'number') return raw.trim() === '' ? NaN : Number(raw);
    if (field.type === 'boolean') return raw === 'true';
    return raw.trim();
  };

  let parsed: unknown;
  if (typedOp === 'between') parsed = [convert(value), convert(valueTo)];
  else if (typedOp === 'in' || typedOp === 'not_in') parsed = list(value).map(convert);
  else parsed = convert(value);

  const empty = (v: unknown) => v === '' || (typeof v === 'number' && Number.isNaN(v));
  if (Array.isArray(parsed) ? parsed.length === 0 || parsed.some(empty) : empty(parsed)) {
    return `Give a value for ${field.label.toLowerCase()}.`;
  }
  return { field: fieldKey, op: typedOp, value: parsed };
}
