import { describe, expect, it } from 'vitest';
import { bySongs } from './song-links';

describe('artists on the other side of samples', () => {
  it('puts both kinds together per artist, most songs first, whatever the case of the name', () => {
    const rows = [
      { takes: 1 as const, kind: 'samples' as const, name: 'James Brown', url: 'https://genius.com/a', n: 2 },
      { takes: 1 as const, kind: 'interpolates' as const, name: 'james brown', url: 'https://genius.com/b', n: 1 },
      { takes: 1 as const, kind: 'samples' as const, name: 'Aly-Us', url: 'https://genius.com/c', n: 1 },
      { takes: 1 as const, kind: 'interpolates' as const, name: 'Common', url: 'https://genius.com/d', n: 1 },
    ];
    expect(bySongs(rows, 2).map((a) => [a.name, a.samples, a.interpolations])).toEqual([
      ['James Brown', 2, 1],
      ['Aly-Us', 1, 0],
    ]);
  });
});
