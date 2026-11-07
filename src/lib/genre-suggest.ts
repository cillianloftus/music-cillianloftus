/**
 * Where each genre might belong, from MusicBrainz's genre relationships
 * (src/data/mb-genre-relations.json, refreshed by
 * scripts/mb-genre-relations.ts). MusicBrainz says what a genre is a
 * subgenre of, a fusion of, and influenced by; this turns that into
 * parents from this library, to file a genre under with one tap.
 *
 * Suggestions only. Nothing is applied without being chosen, and one
 * turned down stays turned down (genre_suggestion_dismissed, 0031).
 */

import { env } from 'cloudflare:workers';
import mb from '../data/mb-genre-relations.json';
import { genreKey, type GenreRow } from './genres';

export type Relation = 'sub' | 'fusion' | 'infl';
export type MbRelations = Record<string, Partial<Record<Relation, string[]>>>;

export interface ParentPick {
  /** The library genre; null when it is not in the library yet. */
  id: string | null;
  name: string;
  relation: Relation;
  /**
   * The genre MusicBrainz actually names, when it is not in the library and
   * this is the nearest genre above it that is: pop rap is a subgenre of
   * hip hop, so a library without hip hop but with rap is offered rap.
   */
  via?: string;
}

export interface GenreSuggestion {
  id: string;
  name: string;
  tracks: number;
  /** Has a primary parent already: picks are offered as further parents. */
  placed: boolean;
  picks: ParentPick[];
  /** Every parent of a fusion, when all are in the library: one tap files it under each. */
  fusion: ParentPick[] | null;
}

/** How far up MusicBrainz's subgenre chain to look for a genre in the library. */
const MAX_CLIMB = 3;

const RANK: Record<Relation, number> = { fusion: 0, sub: 1, infl: 2 };

export function suggestParents(
  rows: Pick<GenreRow, 'id' | 'name' | 'parent_id' | 'also' | 'tracks'>[],
  relations: MbRelations,
  dismissed: Iterable<{ genre_id: string; parent_key: string }> = [],
): GenreSuggestion[] {
  const byKey = new Map(rows.map((r) => [genreKey(r.name), r]));
  const mbByKey = new Map(Object.entries(relations).map(([name, r]) => [genreKey(name), r]));
  const turnedDown = new Set([...dismissed].map((d) => `${d.genre_id}\u0000${d.parent_key}`));

  // Every parent link in the library, primary or further.
  const up = new Map<string, string[]>();
  const down = new Map<string, string[]>();
  for (const r of rows) {
    for (const p of [r.parent_id, ...r.also]) {
      if (!p) continue;
      up.set(r.id, [...(up.get(r.id) ?? []), p]);
      down.set(p, [...(down.get(p) ?? []), r.id]);
    }
  }
  const reach = (from: string, edges: Map<string, string[]>) => {
    const seen = new Set<string>();
    const stack = [...(edges.get(from) ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(edges.get(id) ?? []));
    }
    return seen;
  };

  /** Library genres for a MusicBrainz name: itself, else the nearest above it. */
  const resolve = (name: string): { row: (typeof rows)[number] | null; name: string; via?: string }[] => {
    const own = byKey.get(genreKey(name));
    if (own) return [{ row: own, name: own.name }];
    let level = [name];
    const seen = new Set([genreKey(name)]);
    for (let step = 0; step < MAX_CLIMB && level.length; step++) {
      const next: string[] = [];
      for (const n of level) {
        const r = mbByKey.get(genreKey(n));
        for (const p of [...(r?.sub ?? []), ...(r?.fusion ?? [])]) {
          if (seen.has(genreKey(p))) continue;
          seen.add(genreKey(p));
          next.push(p);
        }
      }
      const found = next.flatMap((n) => {
        const row = byKey.get(genreKey(n));
        return row ? [{ row, name: row.name, via: name }] : [];
      });
      if (found.length) return found;
      level = next;
    }
    return [{ row: null, name }];
  };

  const out: GenreSuggestion[] = [];
  for (const row of rows) {
    const rel = mbByKey.get(genreKey(row.name));
    if (!rel) continue;
    const ancestors = reach(row.id, up);
    const descendants = reach(row.id, down);
    const picks = new Map<string, ParentPick>();
    for (const relation of ['fusion', 'sub', 'infl'] as const) {
      for (const target of rel[relation] ?? []) {
        for (const hit of resolve(target)) {
          // An influence not in the library is too loose to suggest adding.
          if (!hit.row && relation === 'infl') continue;
          if (hit.row && (hit.row.id === row.id || ancestors.has(hit.row.id) || descendants.has(hit.row.id))) continue;
          const key = genreKey(hit.name);
          if (turnedDown.has(`${row.id}\u0000${key}`)) continue;
          const existing = picks.get(key);
          if (existing && RANK[existing.relation] <= RANK[relation]) continue;
          picks.set(key, { id: hit.row?.id ?? null, name: hit.name, relation, ...(hit.via ? { via: hit.via } : {}) });
        }
      }
    }
    if (picks.size === 0) continue;
    const list = [...picks.values()].sort((a, b) => RANK[a.relation] - RANK[b.relation] || Number(a.id === null) - Number(b.id === null));
    const fusionParts = list.filter((p) => p.relation === 'fusion');
    const fusion =
      !row.parent_id && fusionParts.length >= 2 && fusionParts.every((p) => p.id) && fusionParts.length === (rel.fusion?.length ?? 0)
        ? fusionParts
        : null;
    out.push({ id: row.id, name: row.name, tracks: row.tracks, placed: Boolean(row.parent_id), picks: list, fusion });
  }
  // Unplaced genres first, as they need it most; then by how much they hold.
  return out.sort((a, b) => Number(a.placed) - Number(b.placed) || b.tracks - a.tracks || a.name.localeCompare(b.name));
}

/**
 * The suggestions with one clear answer for a genre at the top level: a
 * fusion whose parts are all here, or a single subgenre-of parent in the
 * library. What "file them all" applies; the first parent is primary.
 */
export function clearPlacements(suggestions: GenreSuggestion[]): { id: string; name: string; parents: ParentPick[] }[] {
  return suggestions.flatMap((s) => {
    if (s.placed) return [];
    if (s.fusion) return [{ id: s.id, name: s.name, parents: s.fusion }];
    const subs = s.picks.filter((p) => p.relation === 'sub');
    if (subs.length === 1 && subs[0].id && !s.picks.some((p) => p.relation === 'fusion')) return [{ id: s.id, name: s.name, parents: subs }];
    return [];
  });
}

export const mbRelations = (mb as { relations: MbRelations }).relations;

export async function dismissedSuggestions(): Promise<{ genre_id: string; parent_key: string }[]> {
  const { results } = await env.DB.prepare(`SELECT genre_id, parent_key FROM genre_suggestion_dismissed`).all<{ genre_id: string; parent_key: string }>();
  return results;
}

export async function dismissSuggestion(genreId: string, parentName: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO genre_suggestion_dismissed (genre_id, parent_key) VALUES (?, ?) ON CONFLICT DO NOTHING`)
    .bind(genreId, genreKey(parentName))
    .run();
}
