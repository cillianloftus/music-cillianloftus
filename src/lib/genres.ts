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
  /** The primary parent: decides the colour family and where it is drawn. */
  parent_id: string | null;
  /** Further parents (0013). */
  also: string[];
  /** Distinct tracks tagged with exactly this genre. */
  tracks: number;
}

export interface GenreTreeNode {
  id: string;
  /** Unique within the tree: a genre under a second parent appears twice. */
  key: string;
  name: string;
  /** Drawn here because this is one of its further parents, not its primary one. */
  secondary: boolean;
  /** Tracks tagged with this genre itself. */
  tracks: number;
  /** Tracks in this genre and everything beneath it (a track counts once per genre). */
  total: number;
  children: GenreTreeNode[];
}

export async function genreRows(): Promise<GenreRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.name, g.parent_id,
            (SELECT json_group_array(p.parent_id) FROM genre_extra_parent p WHERE p.genre_id = g.id) AS also,
            (SELECT count(DISTINCT vg.recording_id) FROM v_recording_genre vg WHERE vg.genre_id = g.id) AS tracks
     FROM genre g
     ORDER BY g.name`,
  ).all<Omit<GenreRow, 'also'> & { also: string }>();
  return results.map((r) => ({ ...r, also: JSON.parse(r.also ?? '[]') as string[] }));
}

/**
 * Nests rows under their parents, and again under each further parent
 * (marked secondary). Genres whose whole subtree is empty are dropped. A
 * primary parent that is missing (or would form a cycle) makes a genre a
 * root rather than losing it.
 */
export function buildGenreTree(rows: GenreRow[]): GenreTreeNode[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const children = new Map<string | null, { row: GenreRow; secondary: boolean }[]>();
  const add = (parent: string | null, row: GenreRow, secondary: boolean) =>
    children.set(parent, [...(children.get(parent) ?? []), { row, secondary }]);

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
    add(parent, row, false);
    for (const extra of row.also) if (byId.has(extra) && extra !== parent) add(extra, row, true);
  }

  const build = (row: GenreRow, secondary: boolean, key: string, path: Set<string>): GenreTreeNode => {
    const inner = new Set(path).add(row.id);
    const kids = (children.get(row.id) ?? [])
      // The database refuses cycles; this guards a hand-edited one all the same.
      .filter((c) => !inner.has(c.row.id))
      .map((c) => build(c.row, c.secondary, `${key}/${c.row.id}`, inner))
      .filter((child) => child.total > 0);
    const total = row.tracks + kids.reduce((sum, child) => sum + child.total, 0);
    return { id: row.id, key, name: row.name, secondary, tracks: row.tracks, total, children: kids };
  };

  return (children.get(null) ?? [])
    .map((c) => build(c.row, false, c.row.id, new Set()))
    .filter((node) => node.total > 0)
    .sort((a, b) => b.total - a.total);
}

export interface PackedCircle {
  /** Unique per circle (a genre under two parents is two circles). */
  id: string;
  /** The genre itself, for links. */
  genreId: string;
  name: string;
  /** Drawn under one of its further parents. */
  secondary: boolean;
  x: number;
  y: number;
  r: number;
  depth: number;
  /** Tracks this circle's area stands for. */
  value: number;
  /** True for the circle holding a parent genre's own tracks. */
  self: boolean;
  leaf: boolean;
  /** The top-level genre it sits under (itself, at the top): its colour family. */
  family: string;
  /** The enclosing circle's id; null at the top level. */
  parent: string | null;
}

interface PackDatum {
  id: string;
  genreId: string;
  name: string;
  value: number;
  self: boolean;
  secondary: boolean;
  children?: PackDatum[];
}

/**
 * Circle-packing layout, computed on the server. In a pack, only leaves
 * have area, so a parent's own tracks get a child circle of their own
 * ("self"); otherwise a parent tagged directly would look empty.
 */
export function packGenres(roots: GenreTreeNode[], size: number): PackedCircle[] {
  const toDatum = (node: GenreTreeNode): PackDatum => {
    const base = { id: node.key, genreId: node.id, name: node.name, secondary: node.secondary };
    if (node.children.length === 0) return { ...base, value: node.tracks, self: false };
    const children = node.children.map(toDatum);
    if (node.tracks > 0) children.push({ ...base, id: `${node.key}#self`, value: node.tracks, self: true });
    return { ...base, value: 0, self: false, children };
  };

  const root = hierarchy<PackDatum>({
    id: 'root',
    genreId: 'root',
    name: 'All genres',
    value: 0,
    self: false,
    secondary: false,
    children: roots.map(toDatum),
  })
    .sum((d) => (d.children ? 0 : d.value))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  return pack<PackDatum>()
    .size([size, size])
    .padding((node) => (node.depth === 0 ? 6 : 4))(root)
    .descendants()
    .filter((node) => node.depth > 0)
    .map((node) => ({
      id: node.data.id,
      genreId: node.data.genreId,
      name: node.data.name,
      secondary: node.data.secondary,
      x: node.x,
      y: node.y,
      r: node.r,
      depth: node.depth,
      value: node.value ?? 0,
      self: node.data.self,
      leaf: !node.children,
      family: node.ancestors().find((a) => a.depth === 1)?.data.name ?? node.data.name,
      parent: node.parent && node.parent.depth > 0 ? node.parent.data.id : null,
    }));
}

export class GenreError extends Error {}

/** A genre id by name, ignoring case (names are unique without it). */
async function genreIdByName(name: string): Promise<string | null> {
  return env.DB.prepare(`SELECT id FROM genre WHERE name = ? COLLATE NOCASE`).bind(name.trim()).first<string>('id');
}

/**
 * Puts a genre beneath another, or at the top level with null. The
 * database refuses a cycle (migration 0012); that refusal comes back as a
 * GenreError the page can show.
 */
export async function moveGenre(id: string, parentName: string | null): Promise<void> {
  let parentId: string | null = null;
  if (parentName && parentName.trim()) {
    parentId = await genreIdByName(parentName);
    if (!parentId) throw new GenreError(`There is no genre called “${parentName.trim()}”.`);
  }
  try {
    const result = await env.DB.prepare(`UPDATE genre SET parent_id = ? WHERE id = ?`).bind(parentId, id).run();
    if (!result.meta.changes) throw new GenreError('That genre no longer exists.');
  } catch (error) {
    if (error instanceof GenreError) throw error;
    if (String(error).includes('beneath itself')) throw new GenreError('A genre cannot sit beneath itself or anything beneath it.');
    throw error;
  }
}

/**
 * Files a genre under a further parent as well as its primary one. The
 * database refuses a cycle here too (0013).
 */
export async function addParent(id: string, parentName: string): Promise<void> {
  const parentId = await genreIdByName(parentName);
  if (!parentId) throw new GenreError(`There is no genre called “${parentName.trim()}”.`);
  const primary = await env.DB.prepare(`SELECT parent_id FROM genre WHERE id = ?`).bind(id).first<string | null>('parent_id');
  if (primary === parentId) throw new GenreError('That is already its main parent.');
  try {
    await env.DB.prepare(`INSERT INTO genre_extra_parent (genre_id, parent_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).bind(id, parentId).run();
  } catch (error) {
    if (String(error).includes('beneath itself') || String(error).includes('CHECK')) {
      throw new GenreError('A genre cannot sit beneath itself or anything beneath it.');
    }
    throw error;
  }
}

export async function removeParent(id: string, parentId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM genre_extra_parent WHERE genre_id = ? AND parent_id = ?`).bind(id, parentId).run();
}

/** Adds a genre, optionally beneath an existing one. Returns its id. */
export async function createGenre(name: string, parentName: string | null): Promise<string> {
  const clean = name.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!clean || clean.length > 80) throw new GenreError('Give the genre a name of up to 80 characters.');
  if (await genreIdByName(clean)) throw new GenreError(`“${clean}” is already a genre.`);
  let parentId: string | null = null;
  if (parentName && parentName.trim()) {
    parentId = await genreIdByName(parentName);
    if (!parentId) throw new GenreError(`There is no genre called “${parentName.trim()}”.`);
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO genre (id, name, parent_id) VALUES (?, ?, ?)`).bind(id, clean, parentId).run();
  return id;
}

/** "pop music" → "pop": Wikidata's labels often carry a word this library's names do not. */
export const plainGenreName = (label: string) => label.trim().toLowerCase().replace(/\s+music$/, '');

const WIKIDATA = 'https://query.wikidata.org/sparql';

/** Wikidata classes that are categories of music rather than genres to file under. */
const NOT_GENRES = /^(music|music genre|popular|popular music|art music|traditional music|music of .+|.+ music of .+)$/;

/** Spelling-insensitive key for genre names: "hip-hop" and "Hip Hop" are one genre. */
export const genreKey = (name: string) => name.toLowerCase().replace(/[-‐–]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * What Wikidata says each genre is a subclass of (P279), for genres it
 * knows as music genres (instance of Q188451). Names are the keys, as
 * given; parents come back as plain lower-case names.
 */
export async function wikidataParents(names: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (names.length === 0) return out;
  // Quotes, backslashes and line breaks would end the SPARQL string early.
  const literal = (s: string) => `"${s.replace(/["\\\r\n]/g, ' ')}"@en`;
  const query = `SELECT ?name ?parentLabel WHERE {
    VALUES ?name { ${names.slice(0, 200).map(literal).join(' ')} }
    ?genre rdfs:label ?name ; wdt:P31 wd:Q188451 ; wdt:P279 ?parent .
    ?parent rdfs:label ?parentLabel . FILTER(lang(?parentLabel) = "en")
  }`;
  const response = await fetch(WIKIDATA, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/sparql-results+json',
      'User-Agent': 'music-cillianloftus/0.1 ( https://music.cillianloftus.com )',
    },
    body: new URLSearchParams({ query }),
  });
  if (!response.ok) throw new GenreError(`Wikidata returned ${response.status}.`);
  const json = (await response.json()) as { results: { bindings: { name: { value: string }; parentLabel: { value: string } }[] } };
  for (const b of json.results.bindings) {
    const parent = plainGenreName(b.parentLabel.value);
    const name = b.name.value;
    if (parent === name.toLowerCase() || NOT_GENRES.test(parent)) continue;
    const list = out.get(name) ?? [];
    if (!list.includes(parent)) list.push(parent);
    out.set(name, list);
  }
  return out;
}

/** A genre is derived onto an album when at least this share of its tracks carry it. */
export const DERIVE_THRESHOLD = 0.4;

/**
 * Album genres from track genres (ARCHITECTURE.md §3, "Genre"). Recomputed
 * from scratch: every derived album tag is replaced in one transaction,
 * from the tracks of each album's standard edition and their own tags
 * (manual or imported, never derived). Manual and imported album tags are
 * never touched. The weight is the share of tracks, which orders them.
 * An album left with no genres then takes its tracks' genres from the
 * other albums they appear on.
 * Returns how many derived tags now exist.
 */
export async function deriveAlbumGenres(threshold = DERIVE_THRESHOLD): Promise<number> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM genre_tag WHERE entity_type = 'release_group' AND source = 'derived'`),
    env.DB.prepare(
      `INSERT INTO genre_tag (entity_type, entity_id, genre_id, source, weight)
       WITH canon AS (
         SELECT DISTINCT c.release_group_id, t.recording_id
         FROM v_release_group_canonical c JOIN track t ON t.release_id = c.release_id
       ),
       sizes AS (SELECT release_group_id, count(*) AS n FROM canon GROUP BY release_group_id),
       tagged AS (
         SELECT canon.release_group_id, gt.genre_id, count(DISTINCT canon.recording_id) AS k
         FROM canon
         JOIN genre_tag gt ON gt.entity_type = 'recording' AND gt.entity_id = canon.recording_id AND gt.source <> 'derived'
         GROUP BY canon.release_group_id, gt.genre_id
       )
       SELECT 'release_group', tagged.release_group_id, tagged.genre_id, 'derived', round(1.0 * k / n, 3)
       FROM tagged JOIN sizes ON sizes.release_group_id = tagged.release_group_id
       WHERE 1.0 * k / n >= ?1`,
    ).bind(threshold),
    // An album still with no genres at all (a single, typically) takes them
    // from its tracks as they stand anywhere else: the "All Day" single is
    // pop rap because "All Day" is, on the album it also appears on.
    env.DB.prepare(
      `INSERT INTO genre_tag (entity_type, entity_id, genre_id, source, weight)
       WITH canon AS (
         SELECT DISTINCT c.release_group_id, t.recording_id
         FROM v_release_group_canonical c JOIN track t ON t.release_id = c.release_id
       ),
       sizes AS (SELECT release_group_id, count(*) AS n FROM canon GROUP BY release_group_id),
       bare AS (
         SELECT release_group_id FROM sizes
         WHERE NOT EXISTS (SELECT 1 FROM genre_tag g WHERE g.entity_type = 'release_group' AND g.entity_id = sizes.release_group_id)
       ),
       elsewhere AS (
         SELECT canon.release_group_id, canon.recording_id, rg.genre_id
         FROM canon
         JOIN track t2 ON t2.recording_id = canon.recording_id
         JOIN release r2 ON r2.id = t2.release_id AND r2.release_group_id <> canon.release_group_id
         JOIN v_release_group_genre rg ON rg.release_group_id = r2.release_group_id
         WHERE canon.release_group_id IN (SELECT release_group_id FROM bare)
       ),
       tagged AS (
         SELECT release_group_id, genre_id, count(DISTINCT recording_id) AS k FROM elsewhere GROUP BY release_group_id, genre_id
       )
       SELECT 'release_group', tagged.release_group_id, tagged.genre_id, 'derived', round(1.0 * k / n, 3)
       FROM tagged JOIN sizes ON sizes.release_group_id = tagged.release_group_id
       WHERE 1.0 * k / n >= ?1`,
    ).bind(threshold),
  ]);
  return (await env.DB.prepare(`SELECT count(*) AS n FROM genre_tag WHERE source = 'derived'`).first<number>('n')) ?? 0;
}
