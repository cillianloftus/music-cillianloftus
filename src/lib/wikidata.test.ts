import { describe, expect, it } from 'vitest';
import { factClaims } from './sources/wikipedia';

const item = (id: string, qualifiers?: Record<string, unknown>, rank = 'normal') => ({
  mainsnak: { datavalue: { value: { id } } },
  rank,
  ...(qualifiers ? { qualifiers } : {}),
});
const at = (year: number) => [{ datavalue: { value: { time: `+${year}-00-00T00:00:00Z` } } }];

describe('facts from Wikidata', () => {
  it('reads awards with their year, influences and places, skipping deprecated statements and repeats', () => {
    const { facts, nicknames } = factClaims({
      claims: {
        P166: [item('Q-grammy', { P585: at(2016) }), item('Q-grammy', { P585: at(2018) }), item('Q-old', undefined, 'deprecated')],
        P737: [item('Q-influence')],
        P19: [item('Q-compton'), item('Q-second-claim')],
        P1449: [
          { mainsnak: { datavalue: { value: { text: 'K-Dot', language: 'en' } } } },
          { mainsnak: { datavalue: { value: { text: 'ケンドリック', language: 'ja' } } } },
        ],
      },
    });
    expect(facts).toEqual([
      { property: 'award', valueId: 'Q-grammy', year: 2016 },
      { property: 'influenced_by', valueId: 'Q-influence', year: null },
      { property: 'birthplace', valueId: 'Q-compton', year: null },
    ]);
    expect(nicknames.map((n) => n.label)).toEqual(['K-Dot']);
  });
});
