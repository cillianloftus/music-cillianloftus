import { describe, expect, it } from 'vitest';
import { fitLabel, layoutMosaic, SHAPES } from './genre-mosaic';
import { buildGenreTree, type GenreRow } from './genres';

const row = (id: string, name: string, parent_id: string | null, tracks: number): GenreRow => ({ id, name, parent_id, tracks, also: [] });

const rows: GenreRow[] = [
  row('hh', 'hip-hop', null, 3000),
  row('trap', 'trap', 'hh', 400),
  row('boom', 'boom bap', 'hh', 300),
  ...Array.from({ length: 30 }, (_, i) => row(`tiny${i}`, `tiny genre ${i}`, 'hh', 2)),
  row('rock', 'rock', null, 1500),
  row('alt', 'alternative rock', 'rock', 1200),
  row('jazz', 'jazz', null, 900),
  ...Array.from({ length: 20 }, (_, i) => row(`lone${i}`, `lone ${i}`, null, 3)),
];

describe('layoutMosaic', () => {
  const tiles = layoutMosaic(buildGenreTree(rows), SHAPES.tall);

  it('keeps every tile inside the map without overlapping its siblings', () => {
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.x + t.w).toBeLessThanOrEqual(100.001);
      expect(t.y + t.h).toBeLessThanOrEqual(100.001);
    }
  });

  it('nests families as panels with their own tracks and subgenres inside', () => {
    expect(tiles.find((t) => t.key === 'hh')?.kind).toBe('group');
    expect(tiles.find((t) => t.key === 'hh#self')?.kind).toBe('self');
    // A genre with nothing beneath it is a plain tile.
    expect(tiles.find((t) => t.key === 'jazz')?.kind).toBe('tile');
  });

  it('folds genres too small to read into one "more" per parent, keeping their names', () => {
    const more = tiles.filter((t) => t.kind === 'more');
    expect(more.length).toBeGreaterThan(0);
    const hip = more.find((t) => t.genreId === 'hh');
    expect(hip?.names).toContain('tiny genre 0');
    expect(tiles.some((t) => t.name === 'tiny genre 0')).toBe(false);
    const top = more.find((t) => t.genreId === null);
    expect(top?.folded).toBe(20);
  });

  it('labels every genre tile it shows', () => {
    for (const t of tiles.filter((t) => t.kind === 'tile' || t.kind === 'self')) expect(t.label).not.toBeNull();
  });
});

describe('fitLabel', () => {
  it('fits a name in a roomy tile and refuses a sliver', () => {
    expect(fitLabel('hip-hop', 200, 120)).not.toBeNull();
    expect(fitLabel('conscious hip hop', 20, 200)).toBeNull();
  });
});
