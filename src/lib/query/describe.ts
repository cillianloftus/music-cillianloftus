/**
 * Plain-language chips for a definition. Rendered from the definition that
 * actually ran, so what the page says is always what was selected.
 */

import { DEFAULT_SORT, ENTITIES, type Entity } from './fields';
import type { Condition, Definition, Where } from './schema';

const list = (values: unknown[]) => values.map(String).join(', ');

export function describeCondition(entity: Entity, c: Condition): string {
  const field = ENTITIES[entity].fields[c.field]!;
  const name = field.label;
  const v = c.value;

  if (field.type === 'genre') {
    if (c.op === 'in_tree') return `Genre: ${v} and subgenres`;
    if (c.op === 'in') return `Genre: ${list(v as unknown[])}`;
    return `Genre: ${v}`;
  }
  if (field.type === 'date') {
    switch (c.op) {
      case 'eq': return `${name} in ${v}`;
      case 'gte': return `${name} from ${v}`;
      case 'gt': return `${name} after ${v}`;
      case 'lt': return `${name} before ${v}`;
      case 'lte': return `${name} up to ${v}`;
      case 'between': return `${name} ${(v as string[])[0]} to ${(v as string[])[1]}`;
    }
  }
  if (field.type === 'boolean') return v ? name : `Not ${name.toLowerCase()}`;

  switch (c.op) {
    case 'eq': return `${name}: ${v}`;
    case 'neq': return `${name} is not ${v}`;
    case 'gt': return `${name} > ${v}`;
    case 'gte': return `${name} ≥ ${v}`;
    case 'lt': return `${name} < ${v}`;
    case 'lte': return `${name} ≤ ${v}`;
    case 'between': return `${name} ${(v as unknown[])[0]}–${(v as unknown[])[1]}`;
    case 'in': return `${name}: ${list(v as unknown[])}`;
    case 'not_in': return `${name} not ${list(v as unknown[])}`;
    case 'contains': return `${name} contains “${v}”`;
    case 'is_null': return `No ${name.toLowerCase()}`;
    case 'is_not_null': return `Has ${name.toLowerCase()}`;
    default: return `${name} ${c.op} ${v}`;
  }
}

function describeWhere(entity: Entity, node: Where): string[] {
  if ('and' in node) return node.and.flatMap((child) => describeWhere(entity, child));
  if ('or' in node) return [node.or.map((child) => describeWhere(entity, child).join(' and ')).join(' or ')];
  return [describeCondition(entity, node)];
}

export interface Description {
  filters: string[];
  shape: string[];
}

export function describe(definition: Definition): Description {
  const spec = ENTITIES[definition.entity];
  const filters = definition.where ? describeWhere(definition.entity, definition.where) : [];
  const shape: string[] = [];

  const sort = definition.sort ?? DEFAULT_SORT[definition.entity];
  shape.push(
    `By ${sort
      .map((s) => `${spec.fields[s.field]!.label.toLowerCase()} ${s.dir === 'desc' ? '↓' : '↑'}`)
      .join(', then ')}`,
  );
  if (definition.group) {
    shape.push(`Top ${definition.group.limit_per_group} per ${spec.groups[definition.group.by]!.label.toLowerCase()}`);
  }
  if (definition.entity === 'recording') {
    shape.push(definition.collapse_by_work ? 'One version per song' : 'All versions');
  }
  shape.push(`Up to ${definition.limit}`);

  return { filters, shape };
}
