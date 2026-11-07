/**
 * The genre tree drawn as a tree: a trunk holding every track, boughs for
 * the families, branches thinning as genres narrow, and a leaf for each
 * genre, out at the canopy's edge or at the fork where its own subgenres
 * part. A branch's thickness is how many tracks sit beneath it.
 *
 * A genre with more than one parent grows from its primary one and is
 * grafted onto the others: a second, thinner branch reaches it from each,
 * so pop rap sits on hip hop with a branch from pop running into it.
 *
 * Laid out on the server (d3-hierarchy's cluster, bent into a fan) and sent
 * as plain SVG, like the circles were.
 */

import { cluster, hierarchy, type HierarchyPointNode } from 'd3-hierarchy';
import type { GenreRow } from './genres';

export interface ArtBranch {
  d: string;
  width: number;
  family: string;
  /** A further parent's branch into a genre filed elsewhere. */
  graft: boolean;
}

export interface ArtLeaf {
  id: string;
  name: string;
  family: string;
  x: number;
  y: number;
  /** Leaf size, from the genre's own tracks. */
  r: number;
  /** Outward direction, degrees clockwise from straight up. */
  angle: number;
  /** At the canopy's edge (no subgenres), rather than at a fork. */
  outer: boolean;
  tracks: number;
  total: number;
  label: { x: number; y: number; size: number; rotate: number; anchor: 'start' | 'end' | 'middle' } | null;
}

export interface TreeArt {
  viewBox: string;
  trunk: string;
  branches: ArtBranch[];
  leaves: ArtLeaf[];
  /** Genres drawn: each once, however many parents. */
  count: number;
}

interface Node {
  id: string;
  name: string;
  tracks: number;
  total: number;
  family: string;
  children: Node[];
}

/** The fan's width in degrees: a little past level each side, like a crown. */
const SPAN = 200;
/** Canopy radius in drawing units; the rest scales from it. */
const R = 600;
const GLYPH = 0.56;
const MIN_LABEL = 9;

/** Biggest in the middle, the rest alternating outwards: a balanced crown. */
function centreOut<T>(list: T[], size: (t: T) => number): T[] {
  const sorted = [...list].sort((a, b) => size(b) - size(a));
  const left: T[] = [];
  const right: T[] = [];
  sorted.forEach((item, i) => (i % 2 === 0 ? right : left).push(item));
  return [...left.reverse(), ...right];
}

/** A small stable wobble per genre, so the canopy's edge is not a ruled arc. */
function wobble(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return ((h >>> 0) % 1000) / 1000;
}

export function growTree(rows: Pick<GenreRow, 'id' | 'name' | 'parent_id' | 'also' | 'tracks'>[]): TreeArt | null {
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Primary parents only decide where a genre grows; a broken or looping
  // one makes it a bough of its own.
  const parentOf = new Map<string, string | null>();
  for (const r of rows) {
    let parent = r.parent_id && byId.has(r.parent_id) ? r.parent_id : null;
    const seen = new Set([r.id]);
    for (let p = parent; p; p = byId.get(p)?.parent_id ?? null) {
      if (seen.has(p)) {
        parent = null;
        break;
      }
      seen.add(p);
    }
    parentOf.set(r.id, parent);
  }
  const kids = new Map<string | null, string[]>();
  for (const r of rows) kids.set(parentOf.get(r.id)!, [...(kids.get(parentOf.get(r.id)!) ?? []), r.id]);

  const build = (id: string, family: string): Node | null => {
    const r = byId.get(id)!;
    const children = (kids.get(id) ?? []).map((k) => build(k, family)).filter((n): n is Node => n !== null);
    const total = r.tracks + children.reduce((s, c) => s + c.total, 0);
    if (total === 0) return null;
    return { id, name: r.name, tracks: r.tracks, total, family, children: centreOut(children, (c) => c.total) };
  };
  const boughs = (kids.get(null) ?? []).map((id) => build(id, byId.get(id)!.name)).filter((n): n is Node => n !== null);
  if (boughs.length === 0) return null;

  const all = boughs.reduce((s, b) => s + b.total, 0);
  const root = hierarchy<Node>({ id: '', name: '', tracks: 0, total: all, family: '', children: centreOut(boughs, (b) => b.total) });
  const laid = cluster<Node>()
    .size([SPAN, 1])
    // Families stand a little apart from each other.
    .separation((a, b) => (a.parent === b.parent ? 1 : 1.6))(root);

  const depth = Math.max(1, root.height);
  // The fork for each depth: boughs part a third of the way out, then evenly
  // to the canopy, where every outer leaf sits (cluster puts leaves level).
  const radius = (node: HierarchyPointNode<Node>) => {
    if (node.depth === 0) return 0;
    if (!node.children) return R * (0.94 + 0.06 * wobble(node.data.id));
    return R * (0.3 + (0.6 * (node.depth - 1)) / depth);
  };
  const angle = (node: HierarchyPointNode<Node>) => node.x - SPAN / 2;
  const at = (r: number, a: number) => {
    const rad = (a * Math.PI) / 180;
    return { x: r * Math.sin(rad), y: -r * Math.cos(rad) };
  };
  const f = (n: number) => n.toFixed(1);
  const link = (r1: number, a1: number, r2: number, a2: number) => {
    const s = at(r1, a1);
    const t = at(r2, a2);
    const mid = (r1 + r2) / 2;
    const c1 = at(mid, a1);
    const c2 = at(mid, a2);
    return `M${f(s.x)},${f(s.y)}C${f(c1.x)},${f(c1.y)} ${f(c2.x)},${f(c2.y)} ${f(t.x)},${f(t.y)}`;
  };

  const trunkWidth = Math.min(64, Math.max(14, Math.sqrt(all) * 1.4));
  const width = (total: number) => Math.max(1.2, (trunkWidth * Math.sqrt(total)) / Math.sqrt(all));

  const place = new Map<string, { r: number; a: number }>();
  for (const node of laid.descendants()) place.set(node.data.id, { r: radius(node), a: angle(node) });

  const branches: ArtBranch[] = [];
  for (const node of laid.descendants()) {
    if (!node.parent) continue;
    const p = place.get(node.parent.data.id)!;
    const c = place.get(node.data.id)!;
    branches.push({ d: link(p.r, p.a, c.r, c.a), width: width(node.data.total), family: node.data.family, graft: false });
  }
  for (const r of rows) {
    const c = place.get(r.id);
    if (!c) continue;
    const node = laid.descendants().find((n) => n.data.id === r.id)!;
    for (const extra of r.also) {
      const p = place.get(extra);
      if (!p || extra === parentOf.get(r.id)) continue;
      const parent = laid.descendants().find((n) => n.data.id === extra)!;
      branches.push({ d: link(p.r, p.a, c.r, c.a), width: width(node.data.total) * 0.6, family: parent.data.family, graft: true });
    }
  }
  // Thick first, so finer branches lie over them.
  branches.sort((a, b) => Number(a.graft) - Number(b.graft) || b.width - a.width);

  const biggest = Math.max(1, ...laid.descendants().map((n) => n.data.tracks));
  const leaves: ArtLeaf[] = laid
    .descendants()
    .filter((n) => n.depth > 0)
    .map((node) => {
      const { r, a } = place.get(node.data.id)!;
      const pt = at(r, a);
      const outer = !node.children;
      return {
        id: node.data.id,
        name: node.data.name,
        family: node.data.family,
        x: pt.x,
        y: pt.y,
        r: node.data.tracks ? 2.5 + 9.5 * Math.sqrt(node.data.tracks / biggest) : 0,
        angle: a,
        outer,
        tracks: node.data.tracks,
        total: node.data.total,
        label: null,
      };
    });

  // Labels, biggest genres first, each kept only where it has room.
  const size = (total: number) => Math.min(24, MIN_LABEL + 2.2 * Math.log2(1 + total / 4));
  const taken: { a1: number; a2: number }[] = [];
  const boxes: { x1: number; y1: number; x2: number; y2: number }[] = [];
  const clear = (b: (typeof boxes)[number]) => boxes.every((o) => b.x2 < o.x1 || b.x1 > o.x2 || b.y2 < o.y1 || b.y1 > o.y2);
  for (const leaf of [...leaves].sort((a, b) => b.total - a.total)) {
    const s = size(leaf.total);
    if (leaf.outer) {
      // Along the radius, past the leaf, reading outwards on both sides.
      const r = Math.hypot(leaf.x, leaf.y) + leaf.r + 5;
      const half = ((s * 0.62) / r) * (180 / Math.PI);
      const span = { a1: leaf.angle - half, a2: leaf.angle + half };
      if (taken.some((t) => span.a2 > t.a1 && span.a1 < t.a2)) continue;
      taken.push(span);
      const p = at(r, leaf.angle);
      const right = leaf.angle >= 0;
      leaf.label = { x: p.x, y: p.y, size: s, rotate: right ? leaf.angle - 90 : leaf.angle + 90, anchor: right ? 'start' : 'end' };
    } else {
      // At a fork: level, just above it, for the bigger genres.
      const s2 = s + 2;
      const w = leaf.name.length * s2 * GLYPH;
      const y = leaf.y - Math.max(leaf.r, 4) - 6;
      const box = { x1: leaf.x - w / 2 - 3, y1: y - s2, x2: leaf.x + w / 2 + 3, y2: y + 3 };
      if (leaf.total < 8 || !clear(box)) continue;
      boxes.push(box);
      leaf.label = { x: leaf.x, y, size: s2, rotate: 0, anchor: 'middle' };
    }
  }

  // The trunk: from the crown down to the ground, flaring at the foot.
  const ground = R * 0.62;
  // It starts a little inside the crown, narrowed to the boughs leaving it,
  // so they grow out of it rather than off a ledge.
  const top = trunkWidth * 0.32;
  const neck = -trunkWidth * 0.6;
  const foot = trunkWidth * 1.5;
  const trunk =
    `M${f(-top)},${f(neck)}` +
    `C${f(-top * 1.1)},${f(ground * 0.5)} ${f(-top * 1.3)},${f(ground * 0.8)} ${f(-foot)},${f(ground)}` +
    `Q0,${f(ground - trunkWidth * 0.25)} ${f(foot)},${f(ground)}` +
    `C${f(top * 1.3)},${f(ground * 0.8)} ${f(top * 1.1)},${f(ground * 0.5)} ${f(top)},${f(neck)}Z`;

  // Bounds: the canopy with room for labels, the trunk's foot.
  const longest = Math.max(...leaves.filter((l) => l.label && l.outer).map((l) => l.name.length * l.label!.size * GLYPH), 0);
  const reach = R + 20 + longest;
  const sideDrop = Math.max(0, -Math.cos((SPAN / 2) * (Math.PI / 180))) * reach;
  const minY = -reach;
  const maxY = Math.max(ground + 8, sideDrop);
  return {
    viewBox: `${f(-reach)} ${f(minY)} ${f(2 * reach)} ${f(maxY - minY)}`,
    trunk,
    branches,
    leaves,
    count: leaves.length,
  };
}
