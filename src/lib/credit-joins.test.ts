import { describe, expect, it } from 'vitest';
import { creditJoins } from './catalogue';

const line = (parts: [string, string, string][]) => {
  const joins = creditJoins(parts.map(([, role, join_phrase]) => ({ role: role as 'primary', join_phrase })));
  return parts.map(([name], i) => name + (joins[i] ?? '')).join('');
};

describe('credit lines', () => {
  it('say feat. before guests a source gave no joins for', () => {
    expect(line([['Logic', 'primary', ''], ['Wale', 'featured', ''], ['John Lindahl', 'featured', '']])).toBe('Logic feat. Wale & John Lindahl');
    expect(line([['A', 'primary', ''], ['B', 'primary', ''], ['C', 'featured', ''], ['D', 'featured', ''], ['E', 'featured', '']])).toBe('A & B feat. C, D & E');
  });

  it('keep the joins a source gave', () => {
    expect(line([['Logic', 'primary', ' feat. '], ['Lucy Rose', 'featured', ' & '], ['The RattPack', 'featured', '']])).toBe('Logic feat. Lucy Rose & The RattPack');
    expect(line([['Simon', 'primary', ' x '], ['Garfunkel', 'primary', '']])).toBe('Simon x Garfunkel');
    expect(line([['A', 'primary', ' with '], ['B', 'featured', '']])).toBe('A with B');
  });
});

describe('titles without their guests', () => {
  it('drop the feat. part, however it is written', async () => {
    const { withoutFeaturing } = await import('./text');
    expect(withoutFeaturing('Like You Used To (feat. Sophia Rollando)')).toBe('Like You Used To');
    expect(withoutFeaturing('Thank You [ft. Lucy Rose]')).toBe('Thank You');
    expect(withoutFeaturing('Song feat. Someone')).toBe('Song');
    expect(withoutFeaturing('With You')).toBe('With You');
  });
});
