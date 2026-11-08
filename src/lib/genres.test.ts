import { describe, expect, it } from 'vitest';
import { buildGenreTree, deriveAlbumGenres, type GenreRow } from './genres';

const row = (id: string, name: string, parent_id: string | null, tracks: number, also: string[] = []): GenreRow => ({
  id,
  name,
  parent_id,
  tracks,
  also,
});

const rows: GenreRow[] = [
  row('pop', 'pop', null, 4),
  row('indie', 'indie pop', 'pop', 10),
  row('bedroom', 'bedroom pop', 'indie', 2),
  row('rock', 'rock', null, 5),
  row('jazz', 'jazz', null, 0),
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
    const cyclic = buildGenreTree([row('a', 'a', 'b', 1), row('b', 'b', 'a', 1)]);
    const names = (nodes: typeof cyclic): string[] => nodes.flatMap((n) => [n.name, ...names(n.children)]);
    expect(names(cyclic).sort()).toEqual(['a', 'b']);
  });

  it('keeps a genre whose parent is missing', () => {
    expect(buildGenreTree([row('x', 'x', 'gone', 3)]).map((n) => n.name)).toEqual(['x']);
  });

  it('draws a genre under each parent it has, marking the extra ones', () => {
    const tree = buildGenreTree([row('rock', 'rock', null, 1), row('blues', 'blues', null, 1), row('br', 'blues rock', 'rock', 6, ['blues'])]);
    const under = (name: string) => tree.find((n) => n.name === name)!.children;
    expect(under('rock').map((c) => [c.name, c.secondary])).toEqual([['blues rock', false]]);
    expect(under('blues').map((c) => [c.name, c.secondary, c.key])).toEqual([['blues rock', true, 'blues/br']]);
    // Each parent's total includes it: blues rock is blues.
    expect(tree.find((n) => n.name === 'blues')!.total).toBe(7);
  });
});

describe('albums with no genres of their own', () => {
  it('take them from where their tracks appear', async () => {
    const { migratedDb, seedLibrary, insert } = await import('../test/db');
    const { d1 } = await import('../test/d1');
    const { env } = await import('cloudflare:workers');
    const db = migratedDb();
    seedLibrary(db);
    (env as { DB: D1Database }).DB = d1(db);
    // A single carrying Album A's first track, with no tags.
    insert(db, 'release_group', [{ id: 'rg-single', title: 'Song A1', type: 'single', source: 'manual' }]);
    insert(db, 'release', [{ id: 'r-single', release_group_id: 'rg-single', title: 'Song A1', source: 'manual' }]);
    insert(db, 'track', [{ id: 't-single', release_id: 'r-single', recording_id: 'a1', position: 1 }]);
    await deriveAlbumGenres();
    expect(db.prepare(`SELECT g.name, t.source FROM genre_tag t JOIN genre g ON g.id = t.genre_id WHERE t.entity_id = 'rg-single'`).all()).toEqual([
      { name: 'indie pop', source: 'derived' },
    ]);
  });
});
