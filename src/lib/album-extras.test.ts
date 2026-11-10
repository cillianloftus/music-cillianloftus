import { describe, expect, it } from 'vitest';
import { placeIn } from './album-extras';

const on = (number: string | null) => placeIn({ series_id: 's', name: 'A list', type: 'Release group series', number });

describe('a place on a list', () => {
  it('reads a small number as a place, a date as when, and anything else as it is', () => {
    expect(on('42')).toBe('No. 42');
    expect(on('2000-01-19')).toBe('19 January 2000');
    expect(on('1994')).toBe('1994');
    expect(on('2016 winner')).toBe('2016 winner');
    expect(on(null)).toBeNull();
  });
});
