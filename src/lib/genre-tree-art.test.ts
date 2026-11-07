import { describe, expect, it } from 'vitest';
import { growTree } from './genre-tree-art';

const row = (id: string, name: string, tracks: number, parent_id: string | null = null, also: string[] = []) => ({ id, name, tracks, parent_id, also });

describe('growing the genre tree', () => {
  const rows = [
    row('hh', 'hip hop', 50),
    row('pop', 'pop', 30),
    row('pr', 'pop rap', 20, 'hh', ['pop']),
    row('boom', 'boom bap', 10, 'hh'),
    row('empty', 'polka', 0),
  ];

  it('draws each genre with tracks once, and leaves out empty ones', () => {
    const art = growTree(rows)!;
    expect(art.leaves.map((l) => l.id).sort()).toEqual(['boom', 'hh', 'pop', 'pr']);
    expect(art.count).toBe(4);
  });

  it('grafts a genre onto a further parent with a thinner branch in that family', () => {
    const art = growTree(rows)!;
    const grafts = art.branches.filter((b) => b.graft);
    expect(grafts).toHaveLength(1);
    expect(grafts[0].family).toBe('pop');
    const own = art.branches.find((b) => !b.graft && b.family === 'hip hop' && b.width < grafts[0].width / 0.6 + 0.01 && b.width > grafts[0].width);
    expect(own).toBeDefined();
  });

  it('makes branches thicker for more tracks beneath, and puts subgenres outermost', () => {
    const art = growTree(rows)!;
    const leaf = (id: string) => art.leaves.find((l) => l.id === id)!;
    // Hip hop has subgenres, so it is a fork, nearer the trunk than its leaves.
    expect(leaf('hh').outer).toBe(false);
    expect(leaf('pr').outer).toBe(true);
    expect(Math.hypot(leaf('hh').x, leaf('hh').y)).toBeLessThan(Math.hypot(leaf('pr').x, leaf('pr').y));
    const widths = art.branches.filter((b) => !b.graft).map((b) => b.width);
    expect(Math.max(...widths)).toBeGreaterThan(Math.min(...widths));
  });

  it('survives a looping primary parent, and has nothing to draw without tracks', () => {
    const looped = [row('a', 'a', 1, 'b'), row('b', 'b', 1, 'a')];
    expect(growTree(looped)?.count).toBe(2);
    expect(growTree([row('x', 'x', 0)])).toBeNull();
  });

  it('labels without overlap along the canopy', () => {
    const many = Array.from({ length: 300 }, (_, i) => row(`g${i}`, `genre number ${i}`, 1 + (i % 7)));
    const art = growTree(many)!;
    const outer = art.leaves.filter((l) => l.label && l.outer).sort((a, b) => a.angle - b.angle);
    expect(outer.length).toBeGreaterThan(20);
    expect(outer.length).toBeLessThan(300);
    for (let i = 1; i < outer.length; i++) {
      const r = Math.hypot(outer[i].label!.x, outer[i].label!.y);
      const gap = ((outer[i].angle - outer[i - 1].angle) * Math.PI) / 180;
      expect(gap * r).toBeGreaterThanOrEqual(Math.min(outer[i].label!.size, outer[i - 1].label!.size) * 0.6);
    }
  });
});
