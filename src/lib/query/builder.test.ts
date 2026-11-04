import { describe, expect, it } from 'vitest';
import {
  addCondition,
  chipConditions,
  conditionFromForm,
  decodeDefinition,
  encodeDefinition,
  removeCondition,
  replaceCondition,
  starterDefinition,
  switchEntity,
  withShape,
} from './builder';
import { definitionSchema } from './schema';

const base = starterDefinition('recording');
const score80 = { field: 'personal_score', op: 'gte' as const, value: 80 };
const pop = { field: 'genre', op: 'in_tree' as const, value: 'pop' };

describe('URL encoding', () => {
  it('round-trips, including non-ASCII', () => {
    const definition = addCondition(base, { field: 'artist', op: 'eq', value: 'Björk' });
    const encoded = encodeDefinition(definition);
    expect(encoded).toMatch(/^[\w-]+$/);
    expect(decodeDefinition(encoded)).toEqual(definition);
  });
});

describe('chip edits', () => {
  it('adds, replaces and removes top-level conditions', () => {
    let d = addCondition(base, score80);
    d = addCondition(d, pop);
    expect(chipConditions(d)).toEqual([score80, pop]);

    d = replaceCondition(d, 0, { ...score80, value: 90 });
    expect(chipConditions(d)![0]!.value).toBe(90);

    d = removeCondition(d, 0);
    expect(chipConditions(d)).toEqual([pop]);
    d = removeCondition(d, 0);
    expect(d.where).toBeUndefined();
  });

  it('treats OR and nesting as read-only', () => {
    const d = definitionSchema.parse({ entity: 'recording', where: { or: [score80, pop] } });
    expect(chipConditions(d)).toBeNull();
  });

  it('every edit stays a valid definition', () => {
    const d = withShape(addCondition(base, score80), { sort: 'title', dir: 'asc', limit: '25', groupBy: 'artist', perGroup: '3' });
    expect(definitionSchema.safeParse(d).success).toBe(true);
    expect(d).toMatchObject({ sort: [{ field: 'title', dir: 'asc' }], limit: 25, group: { by: 'artist', limit_per_group: 3 } });
    expect(withShape(d, { groupBy: '' }).group).toBeUndefined();
  });

  it('switching entity clears field-specific parts', () => {
    const d = switchEntity(withShape(addCondition(base, score80), { sort: 'title', limit: '20' }), 'release_group');
    expect(d).toMatchObject({ entity: 'release_group', limit: 20 });
    expect(d.where).toBeUndefined();
    expect(d.sort).toBeUndefined();
  });
});

describe('conditionFromForm', () => {
  it('types values by field', () => {
    expect(conditionFromForm('recording', 'personal_score', 'gte', '85', '')).toEqual({ field: 'personal_score', op: 'gte', value: 85 });
    expect(conditionFromForm('recording', 'quality_score', 'between', '60', '80')).toEqual({ field: 'quality_score', op: 'between', value: [60, 80] });
    expect(conditionFromForm('recording', 'artist', 'in', 'A, B ,', '')).toEqual({ field: 'artist', op: 'in', value: ['A', 'B'] });
    expect(conditionFromForm('release_group', 'owned', 'eq', 'false', '')).toEqual({ field: 'owned', op: 'eq', value: false });
    expect(conditionFromForm('recording', 'impact', 'is_null', 'ignored', '')).toEqual({ field: 'impact', op: 'is_null' });
  });

  it('explains what is missing', () => {
    expect(conditionFromForm('recording', 'personal_score', 'gte', '', '')).toMatch(/Give a value/);
    expect(conditionFromForm('recording', 'personal_score', 'contains', '1', '')).toMatch(/Choose how/);
    expect(conditionFromForm('recording', 'nope', 'eq', '1', '')).toMatch(/Unknown field/);
  });
});
