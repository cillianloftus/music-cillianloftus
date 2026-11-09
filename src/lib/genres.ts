/**
 * The genre tree, sized by how many tracks sit in each genre: a portrait
 * of actual listening, with mass where taste concentrates (ARCHITECTURE.md
 * §8). Track genres follow v_recording_genre: a track's own tags, else its
 * album's.
 */

import { env } from 'cloudflare:workers';
import { byLibrary } from './library-cache';

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

/**
 * SQL for the distinct recordings in any of a set of genres, as
 * v_recording_genre has them: a track's own tags (manual ones winning),
 * else its albums'. `genres` is SQL for the genre ids (a subquery, or a
 * list), or a function giving it, called once per use in the order the
 * uses appear (for positional parameters). Written out because SQLite
 * pushes `genre_id = ?` into the view but not `genre_id IN (SELECT …)`:
 * through the view, rock's tracks cost 88,000 rows (the whole view), and
 * this way 4,600.
 */
export function recordingsInGenres(genres: string | (() => string)): string {
  const set = typeof genres === 'string' ? () => genres : genres;
  const own = set();
  const inherited = set();
  return `SELECT t.entity_id AS recording_id FROM genre_tag t
          WHERE t.entity_type = 'recording' AND t.genre_id IN (${own})
            AND (t.source = 'manual'
                 OR NOT EXISTS (SELECT 1 FROM genre_tag m
                                WHERE m.entity_type = 'recording' AND m.entity_id = t.entity_id AND m.source = 'manual'))
          UNION
          SELECT tr.recording_id FROM v_release_group_genre rg
          JOIN release r ON r.release_group_id = rg.release_group_id
          JOIN track tr ON tr.release_id = r.id
          WHERE rg.genre_id IN (${inherited})
            AND NOT EXISTS (SELECT 1 FROM genre_tag own WHERE own.entity_type = 'recording' AND own.entity_id = tr.recording_id)`;
}

/**
 * SQL for the (recording_id, genre_id) pairs of some recordings, as
 * v_recording_genre has them. `recordings` is a table or CTE name with a
 * recording_id column. Joined to the view, SQLite builds the whole view
 * first (88,000 rows); this way the cost follows the recordings asked about.
 */
export function genresOfRecordings(recordings: string): string {
  return `SELECT t.entity_id AS recording_id, t.genre_id
          FROM ${recordings} x JOIN genre_tag t ON t.entity_type = 'recording' AND t.entity_id = x.recording_id
          WHERE t.source = 'manual'
             OR NOT EXISTS (SELECT 1 FROM genre_tag m
                            WHERE m.entity_type = 'recording' AND m.entity_id = t.entity_id AND m.source = 'manual')
          UNION
          SELECT tr.recording_id, rg.genre_id
          FROM ${recordings} x
          JOIN track tr ON tr.recording_id = x.recording_id
          JOIN release r ON r.id = tr.release_id
          JOIN v_release_group_genre rg ON rg.release_group_id = r.release_group_id
          WHERE NOT EXISTS (SELECT 1 FROM genre_tag own WHERE own.entity_type = 'recording' AND own.entity_id = tr.recording_id)`;
}

/**
 * Distinct tracks tagged with each genre, by genre id: what
 * v_recording_genre says, counted here. Kept until the library changes;
 * ratings do not move it.
 *
 * Counted through the view, the album genres were joined to every track
 * (155,000 rows once tracks had genres of their own). Here three plain
 * reads (the tracks' own tags, the albums' genres, which album each track
 * is on) are put together the way the view does it: a track's own genres
 * (only the hand-set ones when it has any), or, with none of its own,
 * every album's it is on.
 */
export async function trackCountsByGenre(): Promise<Record<string, number>> {
  const index = await genreIndex();
  return Object.fromEntries(Object.entries(index.tracks).map(([g, ids]) => [g, ids.length]));
}

/**
 * Which tracks and albums are in each genre, as v_recording_genre and
 * v_release_group_genre have them, kept per library state: a genre's
 * counts, or its whole subtree's, are worked out from this rather than
 * read again (a big genre's subtree through the views read 42,000 rows).
 */
export interface GenreIndex {
  tracks: Record<string, string[]>;
  albums: Record<string, string[]>;
}

export async function genreIndex(): Promise<GenreIndex> {
  return byLibrary('genre-index:v1', null, async () => {
    // Plain table reads, put together here: through the views and joins
    // they cost 155,000 rows; read raw, about the size of the tables.
    const [own, albumTags, tracks, releases] = await env.DB.batch([
      env.DB.prepare(`SELECT entity_id AS r, genre_id AS g, source = 'manual' AS manual FROM genre_tag WHERE entity_type = 'recording'`),
      env.DB.prepare(`SELECT entity_id AS a, genre_id AS g, source = 'manual' AS manual FROM genre_tag WHERE entity_type = 'release_group'`),
      env.DB.prepare(`SELECT recording_id AS r, release_id AS x FROM track`),
      env.DB.prepare(`SELECT id AS x, release_group_id AS a FROM release`),
    ]);
    const albumOf = new Map((releases!.results as { x: string; a: string }[]).map((r) => [r.x, r.a]));
    const placed = (tracks!.results as { r: string; x: string }[]).flatMap((t) => {
      const a = albumOf.get(t.x);
      return a ? [{ r: t.r, a }] : [];
    });
    const albums = albumGenres(albumTags!.results as { a: string; g: string; manual: number }[]);
    const members = genreMembers(own!.results as { r: string; g: string; manual: number }[], albums, placed);
    const albumsBy: Record<string, string[]> = {};
    for (const { a, g } of albums) (albumsBy[g] ??= []).push(a);
    return { tracks: Object.fromEntries([...members].map(([g, set]) => [g, [...set]])), albums: albumsBy };
  });
}

/** Every parent-to-child edge of the genre tree (v_genre_edge: primary and extra parents), kept per library state. */
export async function genreEdges(): Promise<{ genre_id: string; parent_id: string }[]> {
  return byLibrary('genre-edges:v1', null, async () => {
    const { results } = await env.DB.prepare(`SELECT genre_id, parent_id FROM v_genre_edge`).all<{ genre_id: string; parent_id: string }>();
    return results;
  });
}

/** A genre and everything beneath it, through any parent. Pure. */
export function subtreeOf(id: string, edges: { genre_id: string; parent_id: string }[]): string[] {
  const children = new Map<string, string[]>();
  for (const e of edges) children.set(e.parent_id, [...(children.get(e.parent_id) ?? []), e.genre_id]);
  const seen = new Set([id]);
  const queue = [id];
  while (queue.length) {
    for (const c of children.get(queue.shift()!) ?? []) {
      if (!seen.has(c)) {
        seen.add(c);
        queue.push(c);
      }
    }
  }
  return [...seen];
}

/** Distinct members of any of these genres. Pure. */
export function membersOf(index: Record<string, string[]>, genres: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const g of genres) for (const id of index[g] ?? []) out.add(id);
  return out;
}

/** v_release_group_genre's rule: an album's hand-set genres alone when it has any, else all its tags. Pure. */
export function albumGenres(tags: { a: string; g: string; manual: number }[]): { a: string; g: string }[] {
  const handSet = new Set(tags.filter((t) => t.manual).map((t) => t.a));
  const seen = new Set<string>();
  const out: { a: string; g: string }[] = [];
  for (const t of tags) {
    if (handSet.has(t.a) && !t.manual) continue;
    const key = `${t.a}\u0000${t.g}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ a: t.a, g: t.g });
  }
  return out;
}

/** v_recording_genre's rule, counted: own genres (hand-set ones alone when any), else the albums'. Pure. */
export function countTracksByGenre(
  own: { r: string; g: string; manual: number }[],
  albums: { a: string; g: string }[],
  placed: { r: string; a: string }[],
): Record<string, number> {
  return Object.fromEntries([...genreMembers(own, albums, placed)].map(([g, set]) => [g, set.size]));
}

/** v_recording_genre's rule: each genre's tracks. Pure. */
export function genreMembers(
  own: { r: string; g: string; manual: number }[],
  albums: { a: string; g: string }[],
  placed: { r: string; a: string }[],
): Map<string, Set<string>> {
  const tagged = new Map<string, { manual: Set<string>; other: Set<string> }>();
  for (const t of own) {
    const entry = tagged.get(t.r) ?? { manual: new Set<string>(), other: new Set<string>() };
    (t.manual ? entry.manual : entry.other).add(t.g);
    tagged.set(t.r, entry);
  }
  const albumGenres = new Map<string, string[]>();
  for (const x of albums) albumGenres.set(x.a, [...(albumGenres.get(x.a) ?? []), x.g]);

  const genresOf = new Map<string, Set<string>>();
  for (const [r, t] of tagged) genresOf.set(r, t.manual.size > 0 ? t.manual : new Set([...t.manual, ...t.other]));
  for (const { r, a } of placed) {
    if (tagged.has(r)) continue;
    const set = genresOf.get(r) ?? new Set<string>();
    for (const g of albumGenres.get(a) ?? []) set.add(g);
    genresOf.set(r, set);
  }
  const members = new Map<string, Set<string>>();
  for (const [r, set] of genresOf) {
    for (const g of set) {
      const m = members.get(g) ?? new Set<string>();
      m.add(r);
      members.set(g, m);
    }
  }
  return members;
}

export async function genreRows(): Promise<GenreRow[]> {
  const [{ results }, counts] = await Promise.all([
    env.DB.prepare(
      `SELECT g.id, g.name, g.parent_id,
              (SELECT json_group_array(p.parent_id) FROM genre_extra_parent p WHERE p.genre_id = g.id) AS also
       FROM genre g
       ORDER BY g.name`,
    ).all<Omit<GenreRow, 'also' | 'tracks'> & { also: string }>(),
    trackCountsByGenre(),
  ]);
  return results.map((r) => ({ ...r, also: JSON.parse(r.also ?? '[]') as string[], tracks: counts[r.id] ?? 0 }));
}

/**
 * Everything beneath one genre, on its primary parents only, counted the
 * same way as genreRows: its subgenres' map on the genre's page.
 */
export async function genreSubtreeRows(id: string): Promise<GenreRow[]> {
  const [{ results }, counts] = await Promise.all([
    env.DB.prepare(
      `WITH RECURSIVE below(id) AS (
         SELECT id FROM genre WHERE parent_id = ?1
         UNION SELECT g.id FROM genre g JOIN below b ON g.parent_id = b.id
       )
       SELECT g.id, g.name, g.parent_id
       FROM genre g WHERE g.id IN (SELECT id FROM below)
       ORDER BY g.name`,
    )
      .bind(id)
      .all<Omit<GenreRow, 'also' | 'tracks'>>(),
    trackCountsByGenre(),
  ]);
  // The genre itself is not among them, so its children are the roots.
  return results.map((r) => ({ ...r, also: [], tracks: counts[r.id] ?? 0 }));
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

export class GenreError extends Error {}

/** A genre id by name or a name it used to have, ignoring case (names are unique without it). */
async function genreIdByName(name: string): Promise<string | null> {
  return env.DB.prepare(
    `SELECT coalesce((SELECT id FROM genre WHERE name = ?1 COLLATE NOCASE), (SELECT genre_id FROM genre_alias WHERE name = ?1)) AS id`,
  )
    .bind(name.trim())
    .first<string | null>('id');
}

/**
 * Renames a genre everywhere at once: tags point at it by id, so every
 * album and track follows. The old name is kept as an alias, so an import
 * still using it lands here. Renaming onto a genre that already exists
 * merges the two: tags, children and further parents move to that genre,
 * and this one's name becomes its alias. Returns the genre that remains.
 */
export async function renameGenre(id: string, newName: string): Promise<string> {
  const clean = newName.trim().replace(/\s+/g, ' ');
  if (!clean || clean.length > 80) throw new GenreError('Give the genre a name of up to 80 characters.');
  const genre = await env.DB.prepare(`SELECT id, name FROM genre WHERE id = ?`).bind(id).first<{ id: string; name: string }>();
  if (!genre) throw new GenreError('That genre no longer exists.');
  if (genre.name === clean) return id;

  const other = await env.DB.prepare(`SELECT id FROM genre WHERE name = ? COLLATE NOCASE AND id <> ?`).bind(clean, id).first<string>('id');
  const db = env.DB;

  if (!other) {
    await db.batch([
      // Its new name is no longer anybody's old one.
      db.prepare(`DELETE FROM genre_alias WHERE name = ?`).bind(clean),
      db.prepare(`UPDATE genre SET name = ? WHERE id = ?`).bind(clean, id),
      // A change of capitals only needs no alias: names already match without them.
      db.prepare(`INSERT INTO genre_alias (name, genre_id) SELECT ?1, ?2 WHERE lower(?1) <> lower(?3) ON CONFLICT (name) DO UPDATE SET genre_id = ?2`).bind(
        genre.name,
        id,
        clean,
      ),
    ]);
    return id;
  }

  // Onto an existing genre: merge into it.
  const descendants = await db
    .prepare(
      `WITH RECURSIVE below(id) AS (SELECT id FROM genre WHERE parent_id = ?1 UNION SELECT g.id FROM genre g JOIN below b ON g.parent_id = b.id)
       SELECT 1 FROM below WHERE id = ?2`,
    )
    .bind(id, other)
    .first();
  if (descendants) throw new GenreError(`“${clean}” sits beneath “${genre.name}”, so they cannot be merged. Move it out first.`);
  try {
    await db.batch([
      db.prepare(`UPDATE OR IGNORE genre_tag SET genre_id = ?1 WHERE genre_id = ?2`).bind(other, id),
      db.prepare(`DELETE FROM genre_tag WHERE genre_id = ?`).bind(id),
      db.prepare(`UPDATE genre SET parent_id = ?1 WHERE parent_id = ?2 AND id <> ?1`).bind(other, id),
      db.prepare(`UPDATE OR IGNORE genre_extra_parent SET parent_id = ?1 WHERE parent_id = ?2 AND genre_id <> ?1`).bind(other, id),
      db.prepare(`UPDATE OR IGNORE genre_extra_parent SET genre_id = ?1 WHERE genre_id = ?2 AND parent_id <> ?1`).bind(other, id),
      db.prepare(`DELETE FROM genre_extra_parent WHERE genre_id = ?1 OR parent_id = ?1`).bind(id),
      // The kept genre takes this one's place in the tree if it had none.
      db.prepare(`UPDATE genre SET parent_id = (SELECT parent_id FROM genre WHERE id = ?2) WHERE id = ?1 AND parent_id IS NULL AND (SELECT parent_id FROM genre WHERE id = ?2) <> ?1`).bind(other, id),
      db.prepare(`UPDATE genre_alias SET genre_id = ?1 WHERE genre_id = ?2`).bind(other, id),
      db.prepare(`INSERT INTO genre_alias (name, genre_id) VALUES (?1, ?2) ON CONFLICT (name) DO UPDATE SET genre_id = ?2`).bind(genre.name, other),
      db.prepare(`INSERT OR REPLACE INTO entity_redirect (entity_type, old_id, new_id) VALUES ('genre', ?, ?)`).bind(id, other),
      db.prepare(`DELETE FROM genre WHERE id = ?`).bind(id),
    ]);
  } catch (error) {
    if (String(error).includes('beneath itself')) throw new GenreError('Merging those would put a genre beneath itself. Move one of them first.');
    throw error;
  }
  return other;
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
 * Album genres from track genres (ARCHITECTURE.md §3, "Genre"): from the
 * tracks of each album's standard edition and their own tags (manual or
 * imported, never derived). Manual and imported album tags are never
 * touched. The weight is the share of tracks, which orders them. An album
 * left with no genres then takes its tracks' genres from the other albums
 * they appear on. Returns how many derived tags now exist.
 *
 * Worked out here from four plain reads, and only what changed is
 * written. In SQL it read about 190,000 rows, and deleting every derived
 * tag to write them again moved the library's cache stamp each time, so
 * every page was worked out afresh after a run that changed nothing.
 */
export async function deriveAlbumGenres(threshold = DERIVE_THRESHOLD): Promise<number> {
  const [canonRows, trackRows, recordingTags, albumTags] = await env.DB.batch([
    env.DB.prepare(`SELECT release_group_id AS a, release_id AS x FROM v_release_group_canonical`),
    env.DB.prepare(`SELECT t.release_id AS x, t.recording_id AS r, rl.release_group_id AS a FROM track t JOIN release rl ON rl.id = t.release_id`),
    env.DB.prepare(`SELECT entity_id AS r, genre_id AS g FROM genre_tag WHERE entity_type = 'recording' AND source <> 'derived'`),
    env.DB.prepare(`SELECT entity_id AS a, genre_id AS g, source, weight FROM genre_tag WHERE entity_type = 'release_group'`),
  ]);
  const want = derivedAlbumGenres(
    canonRows!.results as { a: string; x: string }[],
    trackRows!.results as { x: string; r: string; a: string }[],
    recordingTags!.results as { r: string; g: string }[],
    (albumTags!.results as { a: string; g: string; source: string; weight: number }[]).filter((t) => t.source !== 'derived'),
    threshold,
  );
  const have = new Map(
    (albumTags!.results as { a: string; g: string; source: string; weight: number }[])
      .filter((t) => t.source === 'derived')
      .map((t) => [`${t.a} ${t.g}`, t.weight]),
  );
  const gone = [...have.keys()].filter((k) => !want.has(k)).map((k) => k.split(' '));
  const changed = [...want].filter(([k, w]) => have.get(k) !== w).map(([k, w]) => [...k.split(' '), w] as const);
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < gone.length; i += 200) {
    statements.push(
      env.DB.prepare(
        `DELETE FROM genre_tag WHERE entity_type = 'release_group' AND source = 'derived'
           AND (entity_id, genre_id) IN (SELECT j.value ->> 0, j.value ->> 1 FROM json_each(?1) j)`,
      ).bind(JSON.stringify(gone.slice(i, i + 200))),
    );
  }
  for (let i = 0; i < changed.length; i += 200) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO genre_tag (entity_type, entity_id, genre_id, source, weight)
         SELECT 'release_group', j.value ->> 0, j.value ->> 1, 'derived', j.value ->> 2 FROM json_each(?1) j WHERE true
         ON CONFLICT (entity_type, entity_id, genre_id, source) DO UPDATE SET weight = excluded.weight`,
      ).bind(JSON.stringify(changed.slice(i, i + 200))),
    );
  }
  if (statements.length > 0) await env.DB.batch(statements);
  return want.size;
}

/**
 * The derived album tags, by "album genre", with their weights. Pure.
 * `albumTags` are the albums' own (non-derived) tags.
 */
export function derivedAlbumGenres(
  canon: { a: string; x: string }[],
  tracks: { x: string; r: string; a: string }[],
  recordingTags: { r: string; g: string }[],
  albumTags: { a: string; g: string; source: string }[],
  threshold: number,
): Map<string, number> {
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const standardOf = new Map(canon.map((c) => [c.a, c.x]));
  const onRelease = new Map<string, Set<string>>();
  const albumsOf = new Map<string, Set<string>>();
  for (const t of tracks) {
    (onRelease.get(t.x) ?? onRelease.set(t.x, new Set()).get(t.x)!).add(t.r);
    (albumsOf.get(t.r) ?? albumsOf.set(t.r, new Set()).get(t.r)!).add(t.a);
  }
  const tagsOf = new Map<string, Set<string>>();
  for (const t of recordingTags) (tagsOf.get(t.r) ?? tagsOf.set(t.r, new Set()).get(t.r)!).add(t.g);

  // Each album's standard edition's tracks.
  const canonTracks = new Map<string, Set<string>>();
  for (const [a, x] of standardOf) {
    const set = onRelease.get(x);
    if (set && set.size > 0) canonTracks.set(a, set);
  }

  // From its own tracks' tags.
  const out = new Map<string, number>();
  for (const [a, rs] of canonTracks) {
    const k = new Map<string, number>();
    for (const r of rs) for (const g of tagsOf.get(r) ?? []) k.set(g, (k.get(g) ?? 0) + 1);
    for (const [g, n] of k) if (n / rs.size >= threshold) out.set(`${a} ${g}`, round(n / rs.size));
  }

  // Albums' genres as v_release_group_genre has them, the derived ones included.
  const own = new Map<string, { manual: Set<string>; other: Set<string> }>();
  const note = (a: string, g: string, manual: boolean) => {
    const e = own.get(a) ?? own.set(a, { manual: new Set(), other: new Set() }).get(a)!;
    (manual ? e.manual : e.other).add(g);
  };
  for (const t of albumTags) note(t.a, t.g, t.source === 'manual');
  for (const k of out.keys()) {
    const [a, g] = k.split(' ');
    note(a!, g!, false);
  }
  const genresOfAlbum = (a: string): Set<string> => {
    const e = own.get(a);
    if (!e) return new Set();
    return e.manual.size > 0 ? e.manual : new Set([...e.other]);
  };

  // An album with no genres at all takes its tracks' genres from the other albums they are on.
  for (const [a, rs] of canonTracks) {
    if (own.has(a)) continue;
    const k = new Map<string, number>();
    for (const r of rs) {
      const found = new Set<string>();
      for (const other of albumsOf.get(r) ?? []) if (other !== a) for (const g of genresOfAlbum(other)) found.add(g);
      for (const g of found) k.set(g, (k.get(g) ?? 0) + 1);
    }
    for (const [g, n] of k) if (n / rs.size >= threshold) out.set(`${a} ${g}`, round(n / rs.size));
  }
  return out;
}
