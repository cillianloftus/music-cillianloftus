import { describe, expect, it } from 'vitest';
import { rankSimilar } from './pages';

describe('more like this', () => {
  const profiles = {
    genres: {
      me: { rock: 3, folk: 1 },
      close: { rock: 2, folk: 1 }, // 2 + 1
      rocky: { rock: 5 }, // 3
      folky: { folk: 4 }, // 1
      jazz: { jazz: 2 },
    },
    artists: { me: ['a'], sibling: ['a'], close: ['b'] },
  };

  it('scores shared genres by the smaller weight, and the same artist 1.5 more', () => {
    expect(rankSimilar('me', profiles, 10)).toEqual(['close', 'rocky', 'sibling', 'folky']);
  });

  it('leaves out the album itself and anything sharing nothing', () => {
    const ranked = rankSimilar('me', profiles, 10);
    expect(ranked).not.toContain('me');
    expect(ranked).not.toContain('jazz');
  });

  it('keeps to the limit', () => {
    expect(rankSimilar('me', profiles, 2)).toEqual(['close', 'rocky']);
  });
});
