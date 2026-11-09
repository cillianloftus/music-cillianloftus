import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { migratedDb, seedLibrary } from '../test/db';
import { byDecade, fillMonths, insights } from './insights';

beforeEach(() => {
  const db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

describe('insights', () => {
  it('bands scores, groups decades and genre families, counts artists', async () => {
    // Owner's seeded tracks score a1 90, a2 70, a3 50, a4 100, b1 80, b2 60, c1 95.
    const data = await insights('u-owner');
    expect(data.headline).toMatchObject({ ratedTracks: 7, impactTracks: 0, gutOffset: 0 });
    expect(data.spread.map((b) => b.count)).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 3]);
    expect(data.decades.map((d) => d.key)).toEqual(['1990s', '2010s', '2020s']);
    // Families walk up to the root: subgenres count under their family.
    expect(data.families.map((f) => f.label).sort()).toEqual(['pop', 'rock']);
    expect(data.artists[0]).toMatchObject({ name: 'Xavier', tracks: 6 });
  });

  it('fills empty months between the first and last', () => {
    expect(fillMonths([{ month: '2025-11', count: 2 }, { month: '2026-02', count: 1 }]).map((m) => [m.month, m.count])).toEqual([
      ['2025-11', 2],
      ['2025-12', 0],
      ['2026-01', 0],
      ['2026-02', 1],
    ]);
  });
});

describe('albums by decade', () => {
  it('averages each decade, oldest first, leaving undated albums out', () => {
    expect(
      byDecade([
        { quality: 80, released: '2016-05-01' },
        { quality: 60, released: '2019' },
        { quality: 90, released: '1999-01' },
        { quality: 10, released: null },
      ]),
    ).toEqual([
      { key: '1990s', label: '1990s', average: 90, count: 1 },
      { key: '2010s', label: '2010s', average: 70, count: 2 },
    ]);
  });
});
