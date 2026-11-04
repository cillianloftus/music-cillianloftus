import { describe, expect, it } from 'vitest';
import { buildGenreTree, packGenres, type GenreRow } from './genres';

const rows: GenreRow[] = [
  { id: 'pop', name: 'pop', parent_id: null, tracks: 4 },
  { id: 'indie', name: 'indie pop', parent_id: 'pop', tracks: 10 },
  { id: 'bedroom', name: 'bedroom pop', parent_id: 'indie', tracks: 2 },
  { id: 'rock', name: 'rock', parent_id: null, tracks: 5 },
  { id: 'jazz', name: 'jazz', parent_id: null, tracks: 0 },
];

describe('buildGenreTree', () => {
  const tree = buildGenreTree(rows);

  it('nests genres and totals each subtree', () => {
    expect(tree.map((n) => [n.name, n.total])).toEqual([
      ['pop', 16],
      ['rock', 5],
    ]);
    expect(tree[0]!.children[0]!.children[0]!.name).toBe('bedroom pop');
  });

  it('drops genres with nothing in them', () => {
    expect(tree.find((n) => n.id === 'jazz')).toBeUndefined();
  });

  it('survives a cycle by promoting a genre to a root', () => {
    const cyclic = buildGenreTree([
      { id: 'a', name: 'a', parent_id: 'b', tracks: 1 },
      { id: 'b', name: 'b', parent_id: 'a', tracks: 1 },
    ]);
    const names = (nodes: typeof cyclic): string[] => nodes.flatMap((n) => [n.name, ...names(n.children)]);
    expect(names(cyclic).sort()).toEqual(['a', 'b']);
  });

  it('keeps a genre whose parent is missing', () => {
    expect(buildGenreTree([{ id: 'x', name: 'x', parent_id: 'gone', tracks: 3 }]).map((n) => n.name)).toEqual(['x']);
  });
});

describe('packGenres', () => {
  const circles = packGenres(buildGenreTree(rows), 800);

  it('gives a parent’s own tracks a circle of their own', () => {
    const self = circles.find((c) => c.id === 'pop#self');
    expect(self).toMatchObject({ self: true, value: 4, leaf: true });
  });

  it('sizes area by track count', () => {
    const area = (id: string) => Math.PI * circles.find((c) => c.id === id)!.r ** 2;
    // indie pop's own 10 tracks against rock's 5: twice the area.
    expect(area('indie#self') / area('rock')).toBeCloseTo(2, 1);
  });

  it('keeps every circle inside the canvas', () => {
    for (const c of circles) {
      expect(c.x - c.r).toBeGreaterThanOrEqual(-0.001);
      expect(c.x + c.r).toBeLessThanOrEqual(800.001);
    }
  });
});
