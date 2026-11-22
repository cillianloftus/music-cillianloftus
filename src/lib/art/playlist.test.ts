import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../../test/d1';
import { migratedDb, seedLibrary } from '../../test/db';
import type { SavedDefinition } from '../definitions';
import { definitionSchema } from '../query/schema';
import { artItems } from './inputs';
import { familyColour, familyShares, playlistArtSvg, titleLines, type ArtItem } from './playlist';

const items: ArtItem[] = [
  { score: 90, year: 1977, genre: 'soft rock', root: 'rock' },
  { score: 60, year: 1977, genre: 'rock', root: 'rock' },
  { score: 80, year: 2019, genre: 'bedroom pop', root: 'pop' },
  { score: null, year: null, genre: null, root: null },
];

/** The bars: the rects drawn inside the barcode's mask. */
const bars = (svg: string) => (svg.split('<g mask=')[1]?.split('</g>')[0] ?? '').match(/<rect /g) ?? [];

describe('playlistArtSvg', () => {
  it('is the same image for the same inputs, in any order', () => {
    const a = playlistArtSvg(items, { title: 'Mix' });
    expect(playlistArtSvg([...items].reverse(), { title: 'Mix' })).toBe(a);
  });

  it('draws a bar per track, coloured by genre family', () => {
    const svg = playlistArtSvg(items);
    expect(bars(svg)).toHaveLength(4);
    const rock = familyColour('rock');
    expect(svg).toContain(`hsl(${rock.h} ${rock.s}%`);
  });

  it('spreads heights over the playlist’s own scores: a best-of’s 90s are not one flat row', () => {
    const best = [91, 94, 97, 100].map((score) => ({ score, year: 2020, genre: 'rap', root: 'hip hop' }));
    const barcode = playlistArtSvg(best).split('<g mask=')[1]!.split('</g>')[0]!;
    const heights = [...barcode.matchAll(/height="([\d.]+)" rx=/g)].map((m) => Number(m[1]));
    expect(new Set(heights).size).toBe(4);
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(100);
  });

  it('changes when the scores do', () => {
    const lower = items.map((i) => ({ ...i, score: i.score === null ? null : i.score - 30 }));
    expect(playlistArtSvg(lower)).not.toBe(playlistArtSvg(items));
  });

  it('carries the name, escaped, and what the playlist holds', () => {
    const svg = playlistArtSvg(items, { title: 'Rock & <roll>' });
    expect(svg).toContain('Rock &amp; &lt;roll&gt;');
    expect(svg).toContain('4 songs  ·  1977–2019  ·  averages 77');
  });

  it('is a plain sky with its name for an empty playlist', () => {
    const svg = playlistArtSvg([], { title: 'Nothing yet' });
    expect(bars(svg)).toHaveLength(0);
    expect(svg).not.toContain('<circle');
    expect(svg).toContain('Nothing yet');
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  });

  it('ranks genre families by size', () => {
    expect(familyShares(items).map((s) => s.root)).toEqual(['rock', 'pop', null]);
  });
});

describe('titleLines', () => {
  it('keeps a short name on one large line', () => {
    expect(titleLines('Best songs')).toEqual({ lines: ['Best songs'], size: 64 });
  });
  it('steps down before wrapping, then wraps to two lines', () => {
    expect(titleLines('Everything I love').lines).toEqual(['Everything I love']);
    const long = titleLines('Songs for driving home late through the rain in November');
    expect(long.lines).toHaveLength(2);
    expect(long.size).toBeLessThan(48);
  });
  it('never runs past two lines', () => {
    expect(titleLines('word '.repeat(60)).lines.length).toBeLessThanOrEqual(2);
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
