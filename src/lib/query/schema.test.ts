import { describe, expect, it } from 'vitest';
import { definitionSchema, describeIssues } from './schema';

const errorsFor = (definition: unknown): string[] => {
  const result = definitionSchema.safeParse(definition);
  return result.success ? [] : describeIssues(result.error);
};

describe('definitionSchema', () => {
  it('applies defaults', () => {
    const parsed = definitionSchema.parse({ entity: 'recording' });
    expect(parsed.limit).toBe(50);
    expect(parsed.collapse_by_work).toBe(true);
  });

  it.each([
    ['an unknown field', { entity: 'recording', where: { field: 'danceability', op: 'gt', value: 1 } }, 'Unknown field'],
    ['an operator the type does not allow', { entity: 'recording', where: { field: 'title', op: 'gt', value: 'a' } }, 'does not apply'],
    ['a value of the wrong type', { entity: 'recording', where: { field: 'personal_score', op: 'gte', value: '80' } }, 'must be a number'],
    ['an enum value outside the list', { entity: 'release_group', where: { field: 'type', op: 'eq', value: 'lp' } }, 'must be one of'],
    ['a malformed date', { entity: 'recording', where: { field: 'first_release_date', op: 'gte', value: '2015-13' } }, 'must be a date'],
    ['a value on is_null', { entity: 'recording', where: { field: 'impact', op: 'is_null', value: 1 } }, 'takes no value'],
    ['between with one value', { entity: 'recording', where: { field: 'quality_score', op: 'between', value: [1] } }, 'between takes'],
    ['a limit above the ceiling', { entity: 'recording', limit: 501 }, 'limit'],
    ['an unknown top-level key', { entity: 'recording', sql: 'DELETE FROM rating' }, 'Unrecognized key'],
    ['an unknown key in a condition', { entity: 'recording', where: { field: 'title', op: 'eq', value: 'x', raw: '1=1' } }, ''],
    ['sorting by a filter-only field', { entity: 'recording', sort: [{ field: 'genre', dir: 'asc' }] }, 'Cannot sort'],
    ['grouping by an unknown key', { entity: 'recording', group: { by: 'mood', limit_per_group: 2 } }, 'Cannot group'],
    ['a field from another entity', { entity: 'artist', where: { field: 'title', op: 'eq', value: 'x' } }, 'Unknown field'],
  ])('rejects %s', (_label, definition, message) => {
    const errors = errorsFor(definition);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain(message);
  });

  it('rejects nesting deeper than four levels', () => {
    let where: unknown = { field: 'title', op: 'eq', value: 'x' };
    for (let i = 0; i < 5; i++) where = { and: [where] };
    expect(errorsFor({ entity: 'recording', where }).join(' ')).toContain('nest');
  });
});
