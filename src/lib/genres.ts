/**
 * The genre tree, sized by how many tracks sit in each genre: a portrait
 * of actual listening, with mass where taste concentrates (ARCHITECTURE.md
 * §8). Track genres follow v_recording_genre: a track's own tags, else its
 * album's.
 */

import { env } from 'cloudflare:workers';
import { hierarchy, pack } from 'd3-hierarchy';

export interface GenreRow {
  id: string;
  name: string;
  parent_id: string | null;
  /** Distinct tracks tagged with exactly this genre. */
  tracks: number;
}

export interface GenreTreeNode {
  id: string;
  name: string;
  /** Tracks tagged with this genre itself. */
  tracks: number;
  /** Tracks in this genre and everything beneath it (a track counts once per genre). */
  total: number;
  children: GenreTreeNode[];
}

export async function genreRows(): Promise<GenreRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.name, g.parent_id,
            (SELECT count(DISTINCT vg.recording_id) FROM v_recording_genre vg WHERE vg.genre_id = g.id) AS tracks
     FROM genre g
     ORDER BY g.name`,
  ).all<GenreRow>();
  return results;
}

/**
 * Nests rows under their parents. Genres whose whole subtree is empty are
 * dropped. A parent that is missing (or would form a cycle) makes a genre
 * a root rather than losing it.
 */
export function buildGenreTree(rows: GenreRow[]): GenreTreeNode[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const children = new Map<string | null, GenreRow[]>();

  for (const row of rows) {
    let parent = row.parent_id && byId.has(row.parent_id) ? row.parent_id : null;
    // Walk up to make sure this genre is not its own ancestor.
    const seen = new Set([row.id]);
    for (let p = parent; p; p = byId.get(p)?.parent_id ?? null) {
      if (seen.has(p)) {
        parent = null;
        break;
      }
      seen.add(p);
    }
    children.set(parent, [...(children.get(parent) ?? []), row]);
  }

  const build = (row: GenreRow): GenreTreeNode => {
    const kids = (children.get(row.id) ?? []).map(build).filter((child) => child.total > 0);
    const total = row.tracks + kids.reduce((sum, child) => sum + child.total, 0);
    return { id: row.id, name: row.name, tracks: row.tracks, total, children: kids };
  };

  return (children.get(null) ?? [])
    .map(build)
    .filter((node) => node.total > 0)
    .sort((a, b) => b.total - a.total);
}

export interface PackedCircle {
  id: string;
  name: string;
  x: number;
  y: number;
  r: number;
  depth: number;
  /** Tracks this circle's area stands for. */
  value: number;
  /** True for the circle holding a parent genre's own tracks. */
  self: boolean;
  leaf: boolean;
}

interface PackDatum {
  id: string;
  name: string;
  value: number;
  self: boolean;
  children?: PackDatum[];
}

/**
 * Circle-packing layout, computed on the server. In a pack, only leaves
 * have area, so a parent's own tracks get a child circle of their own
 * ("self"); otherwise a parent tagged directly would look empty.
 */
export function packGenres(roots: GenreTreeNode[], size: number): PackedCircle[] {
  const toDatum = (node: GenreTreeNode): PackDatum => {
    if (node.children.length === 0) return { id: node.id, name: node.name, value: node.tracks, self: false };
    const children = node.children.map(toDatum);
    if (node.tracks > 0) children.push({ id: `${node.id}#self`, name: node.name, value: node.tracks, self: true });
    return { id: node.id, name: node.name, value: 0, self: false, children };
  };

  const root = hierarchy<PackDatum>({ id: 'root', name: 'All genres', value: 0, self: false, children: roots.map(toDatum) })
    .sum((d) => (d.children ? 0 : d.value))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  return pack<PackDatum>()
    .size([size, size])
    .padding((node) => (node.depth === 0 ? 6 : 4))(root)
    .descendants()
    .filter((node) => node.depth > 0)
    .map((node) => ({
      id: node.data.id,
      name: node.data.name,
      x: node.x,
      y: node.y,
      r: node.r,
      depth: node.depth,
      value: node.value ?? 0,
      self: node.data.self,
      leaf: !node.children,
    }));
}
