/**
 * The genre map: a squarified treemap, two levels deep. Each tile's area is
 * the tracks in that genre and everything beneath it; a family is a panel
 * with its name across the top and its subgenres tiled inside. Genres too
 * small to read fold into one "+N more" tile per family, so the map stays
 * calm however many genres the library grows; the full list sits below it.
 *
 * Laid out on the server in abstract units and sent as percentages, so it
 * renders without JavaScript and without layout shift. Label sizes are
 * worked out here too, in units of the map's width (cqi), so the text
 * scales with the map and never spills out of its tile.
 */

import { hierarchy, treemap, treemapSquarify, type HierarchyRectangularNode } from 'd3-hierarchy';
import type { GenreTreeNode } from './genres';

export type TileKind = 'group' | 'tile' | 'self' | 'more';

export interface MosaicTile {
  key: string;
  kind: TileKind;
  /** The genre it stands for; for "more", the genre whose small subgenres it holds (null at the top). */
  genreId: string | null;
  name: string;
  /** Tracks the area stands for. */
  value: number;
  /** Genres folded into a "more" tile. */
  folded: number;
  /** Their names, biggest first. */
  names: string[];
  /** Has subgenres of its own (shown nested, or one tap away on its page). */
  branches: boolean;
  /** Hue key: the family it belongs to. */
  family: string;
  /** Degrees to turn the family's hue, telling subgenres apart on one family's map. */
  shift: number;
  /** 0–1: how big it is against the biggest tile, for colour depth. */
  shade: number;
  /** Position and size, as percentages of the map. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Label size as a share of the map's width (cqi); null when it does not fit. */
  label: number | null;
  /** Whether the track count fits under the label. */
  count: boolean;
  /** Animation order. */
  order: number;
}

export interface MosaicShape {
  width: number;
  height: number;
}

/** A tall map for phones, a wide one for larger screens. */
export const SHAPES = {
  tall: { width: 360, height: 540 },
  wide: { width: 1120, height: 600 },
} satisfies Record<'tall' | 'wide', MosaicShape>;

/** Shorter, for one genre's subgenres on its own page. */
export const SUB_SHAPES = {
  tall: { width: 360, height: 400 },
  wide: { width: 1120, height: 380 },
} satisfies Record<'tall' | 'wide', MosaicShape>;

/** Units, which are roughly pixels at the shape's own width. */
const GAP = 4;
const INSET = 3;
const HEADER = 24;
const MIN_LABEL = 10.5;
const MAX_LABEL = 30;
/** Average glyph width of the bold face, as a share of its size. */
const GLYPH = 0.6;
/** The least share of the map a "more" tile gets. */
const MORE_FLOOR = 0.02;

interface Datum {
  key: string;
  kind: TileKind;
  genreId: string | null;
  name: string;
  value: number;
  folded: number;
  names?: string[];
  branches: boolean;
  family: string;
  shift?: number;
  /** Area to give it, where that differs from its value. */
  area?: number;
  children?: Datum[];
}

/**
 * Tiles under `minShare` of the whole are folded together, one fold per
 * parent; a fold of a single genre is pointless, so a lone small genre
 * stays as it is.
 */
function fold(nodes: Datum[], total: number, minShare: number, parent: { id: string | null; family: string }, forced: Set<string>, dropped: Set<string>): Datum[] {
  const small = nodes.filter((n) => n.value < total * minShare || forced.has(n.key));
  if (small.length === 0 || (small.length === 1 && !forced.has(small[0]!.key))) return nodes;
  const kept = nodes.filter((n) => !small.includes(n));
  const value = small.reduce((sum, n) => sum + n.value, 0);
  const key = `${parent.id ?? 'top'}#more`;
  // Too thin even to say "more": the panel's count still holds them.
  if (dropped.has(key)) return kept;
  return [
    ...kept,
    {
      key,
      names: [...small].sort((a, b) => b.value - a.value).map((n) => n.name),
      // Room enough to read and tap; its label still gives the true count.
      area: Math.max(value, total * MORE_FLOOR),
      kind: 'more',
      genreId: parent.id,
      name: `${small.length} more`,
      value,
      folded: small.length,
      branches: true,
      family: parent.family,
    },
  ];
}

/** Children laid out beneath a genre: its subgenres, plus its own tracks when it has any. */
function inside(node: GenreTreeNode, family: string, total: number, minShare: number, forced: Set<string>, dropped: Set<string>): Datum[] {
  const kids: Datum[] = node.children
    .filter((c) => !c.secondary)
    .map((c) => ({
      key: c.key,
      kind: 'tile',
      genreId: c.id,
      name: c.name,
      value: c.total,
      folded: 0,
      branches: c.children.some((g) => !g.secondary),
      family,
    }));
  if (node.tracks > 0 && kids.length > 0) {
    kids.push({ key: `${node.key}#self`, kind: 'self', genreId: node.id, name: node.name, value: node.tracks, folded: 0, branches: false, family });
  }
  const folded = fold(kids, total, minShare, { id: node.id, family }, forced, dropped);
  // Nothing left beside its own tracks: the genre is one tile, not a panel.
  return folded.length === 1 && folded[0]!.kind === 'self' ? [] : folded;
}

/** How big a name can be set in a box, whole words kept whole; null if not even the smallest size fits. */
export function fitLabel(name: string, w: number, h: number): { size: number; count: boolean } | null {
  const width = w - 2 * 8;
  const height = h - 2 * 6;
  if (width < 24 || height < MIN_LABEL * 1.2) return null;
  const longestWord = Math.max(...name.split(/[\s-]+/).map((word) => word.length), 1);
  let size = Math.min(MAX_LABEL, width / (longestWord * GLYPH), height / 1.25, Math.sqrt(w * h) / 4.2);
  for (; size >= MIN_LABEL; size -= 0.5) {
    const lines = Math.ceil((name.length * GLYPH * size) / width);
    if (lines * size * 1.12 <= height && lines <= 3) {
      const count = lines * size * 1.12 + 13 * 1.5 <= height;
      return { size, count };
    }
  }
  return null;
}

/** A family's name along its panel's top, beside its count where there is room. */
function headerLabel(name: string, w: number): { size: number; count: boolean } | null {
  const room = w - 2 * 8;
  for (let size = 13; size >= MIN_LABEL; size -= 0.5) {
    const needed = name.length * GLYPH * size;
    if (needed <= room) return { size, count: needed + 6 * GLYPH * size <= room };
  }
  return null;
}

/**
 * Lays out the map. `roots` are the genres at its top level: the whole
 * tree on the Genres page, or one genre's subgenres on that genre's page
 * (`self` then carries the tracks tagged with it alone).
 */
export function layoutMosaic(
  roots: GenreTreeNode[],
  shape: MosaicShape,
  options: { minShare?: number; self?: { id: string; name: string; tracks: number }; family?: string } = {},
): MosaicTile[] {
  const minShare = options.minShare ?? 0.008;
  const primary = roots.filter((r) => !r.secondary && r.total > 0);
  const total = primary.reduce((sum, r) => sum + r.total, 0) + (options.self?.tracks ?? 0);
  if (total === 0) return [];

  const build = (forced: Set<string>, flat: Set<string>): Datum[] => {
  let top: Datum[] = primary.map((r, i) => {
    const family = options.family ?? r.name;
    const children = flat.has(r.key) ? [] : inside(r, family, total, minShare, forced, dropped);
    return {
      key: r.key,
      kind: children.length > 0 ? 'group' : 'tile',
      genreId: r.id,
      name: r.name,
      value: r.total,
      folded: 0,
      branches: r.children.some((c) => !c.secondary),
      family,
      // One family's map turns each subgenre's hue a little, either way.
      shift: options.family ? ((i % 5) - 2) * 14 : 0,
      ...(children.length > 0 ? { children } : {}),
    };
  });
  if (options.self && options.self.tracks > 0) {
    top.push({
      key: `${options.self.id}#self`,
      kind: 'self',
      genreId: options.self.id,
      name: options.self.name,
      value: options.self.tracks,
      folded: 0,
      branches: false,
      family: options.family ?? options.self.name,
    });
  }
  return fold(top, total, minShare, { id: options.self?.id ?? null, family: options.family ?? 'more' }, forced, dropped);
  };

  const lay = (data: Datum[]) => {
    const root = hierarchy<Datum>({ key: 'root', kind: 'group', genreId: null, name: '', value: 0, folded: 0, branches: true, family: '', children: data })
      .sum((d) => (d.children ? 0 : (d.area ?? d.value)))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    return treemap<Datum>()
      .size([shape.width, shape.height])
      .tile(treemapSquarify.ratio(1.15))
      .paddingInner((n) => (n.depth === 0 ? GAP : 3))
      .paddingOuter((n) => (n.depth === 0 ? 0 : INSET))
      .paddingTop((n) => (n.depth === 1 && n.children ? HEADER : n.depth === 0 ? 0 : INSET))
      .round(false)(root);
  };

  // A family too small to show its insides with any room becomes one
  // tile, and a genre whose name will not fit joins its family's "more":
  // a tile nobody can read is noise. A few passes settle it.
  const forced = new Set<string>();
  const flat = new Set<string>();
  const dropped = new Set<string>();
  let laid = lay(build(forced, flat));
  for (let pass = 0; pass < 12; pass++) {
    let changed = false;
    for (const node of laid.descendants()) {
      if (node.depth === 0) continue;
      const w = node.x1 - node.x0;
      const h = node.y1 - node.y0;
      if (node.children) {
        if ((w < 96 || h < HEADER + 44) && !flat.has(node.data.key)) {
          flat.add(node.data.key);
          changed = true;
        }
      } else if (!fitLabel(node.data.kind === 'more' ? `+${node.data.name}` : node.data.name, w, h)) {
        const set = node.data.kind === 'more' ? dropped : forced;
        if (!set.has(node.data.key)) {
          set.add(node.data.key);
          changed = true;
        }
      }
    }
    if (!changed) break;
    laid = lay(build(forced, flat));
  }

  const nodes = laid.descendants().filter((n) => n.depth > 0);
  const leaves = nodes.filter((n) => !n.children);
  const biggest = Math.max(1, ...leaves.map((n) => n.data.value));
  const pct = (v: number, of: number) => Number(((v / of) * 100).toFixed(3));
  const toCqi = (units: number) => Number(((units / shape.width) * 100).toFixed(3));

  return nodes.map((n: HierarchyRectangularNode<Datum>, i) => {
    const w = n.x1 - n.x0;
    const h = n.y1 - n.y0;
    const group = Boolean(n.children);
    const text = n.data.kind === 'more' ? `+${n.data.name}` : n.data.name;
    const fit = group ? headerLabel(text, w) : fitLabel(text, w, h);
    return {
      key: n.data.key,
      kind: group ? 'group' : n.data.kind === 'group' ? 'tile' : n.data.kind,
      genreId: n.data.genreId,
      name: n.data.name,
      value: n.children ? (n.value ?? 0) : n.data.value,
      folded: n.data.folded,
      names: n.data.names ?? [],
      branches: n.data.branches,
      family: n.data.family,
      shift: n.ancestors().find((a) => a.depth === 1)?.data.shift ?? 0,
      shade: group ? 0 : Math.sqrt(n.data.value / biggest),
      x: pct(n.x0, shape.width),
      y: pct(n.y0, shape.height),
      w: pct(w, shape.width),
      h: pct(h, shape.height),
      // "+12 more" is a way in, not a genre: never the loudest thing on the map.
      label: fit ? toCqi(n.data.kind === 'more' ? Math.min(fit.size, 18) : fit.size) : null,
      count: fit?.count ?? false,
      order: i,
    };
  });
}
