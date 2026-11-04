import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../../test/d1';
import { migratedDb, seedLibrary } from '../../test/db';
import type { SavedDefinition } from '../definitions';
import { definitionSchema } from '../query/schema';
import { artItems } from './inputs';
import { familyShares, hueOf, playlistArtSvg, type ArtItem } from './playlist';

const items: ArtItem[] = [
  { score: 90, year: 1977, genre: 'soft rock', root: 'rock' },
  { score: 60, year: 1977, genre: 'rock', root: 'rock' },
  { score: 80, year: 2019, genre: 'bedroom pop', root: 'pop' },
  { score: null, year: null, genre: null, root: null },
];

describe('playlistArtSvg', () => {
  it('is the same image for the same inputs, in any order', () => {
    const a = playlistArtSvg(items, { thisYear: 2026 });
    expect(playlistArtSvg([...items].reverse(), { thisYear: 2026 })).toBe(a);
  });

  it('draws a line per dated track and a strip segment per genre family', () => {
    const svg = playlistArtSvg(items, { thisYear: 2026 });
    expect(svg.match(/<line /g)).toHaveLength(3);
    expect(svg.match(/<rect x=/g)).toHaveLength(3); // rock, pop, untagged
    expect(svg).toContain(`hsl(${hueOf('rock')} 65%`);
  });

  it('changes when the scores do', () => {
    const lower = items.map((i) => ({ ...i, score: i.score === null ? null : i.score - 30 }));
    expect(playlistArtSvg(lower, { thisYear: 2026 })).not.toBe(playlistArtSvg(items, { thisYear: 2026 }));
  });

  it('is a plain sky for an empty playlist', () => {
    const svg = playlistArtSvg([], { thisYear: 2026 });
    expect(svg).not.toContain('<line ');
    expect(svg).not.toContain('<circle');
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  });

  it('ranks genre families by size', () => {
    expect(familyShares(items).map((s) => s.root)).toEqual(['rock', 'pop', null]);
  });
});

describe('artItems', () => {
  beforeEach(() => {
    const db = migratedDb();
    seedLibrary(db);
    (env as { DB: D1Database }).DB = d1(db);
  });

  it('reads score, year and genre family for what the playlist holds', async () => {
    const saved = {
      id: 'd1',
      user_id: 'u-owner',
      definition: definitionSchema.parse({ entity: 'recording', where: { field: 'artist', op: 'eq', value: 'Xavier' }, collapse_by_work: false }),
      pins: [],
      excludes: [],
    } as unknown as SavedDefinition;
    const art = await artItems(saved);
    expect(art).toHaveLength(6);
    // a2 is on Album A (2015, indie pop, under pop); b2 is tagged rock itself.
    expect(art).toContainEqual({ score: 70, year: 2015, genre: 'indie pop', root: 'pop' });
    expect(art).toContainEqual({ score: 60, year: 2020, genre: 'rock', root: 'rock' });
  });
});
