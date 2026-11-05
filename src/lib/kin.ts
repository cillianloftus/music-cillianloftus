/**
 * Artists close to another, from the library alone: how alike their genres
 * are (cosine over how often each genre tags their releases) and how many
 * of the same people work with both (writers, producers, engineers, guests).
 * Each comes with the reason, so "close to" is never unexplained.
 */

import { env } from 'cloudflare:workers';
import { byLibrary } from './library-cache';

export interface Kin {
  id: string;
  name: string;
  /** 0 to 1. */
  closeness: number;
  sharedGenres: string[];
  sharedPeople: { id: string; name: string }[];
}

/** Cosine similarity between two sparse count vectors. */
export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of a) {
    na += v * v;
    const w = b.get(k);
    if (w) dot += v * w;
  }
  for (const v of b.values()) nb += v * v;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export async function kinOf(artistId: string, limit = 6): Promise<Kin[]> {
  return byLibrary(`kin:v1:${artistId}:${limit}`, null, () => findKin(artistId, limit));
}

async function findKin(artistId: string, limit: number): Promise<Kin[]> {
  const [genres, people, names] = await env.DB.batch([
    env.DB.prepare(
      `SELECT c.artist_id, g.id AS genre_id, g.name, count(*) AS n
       FROM artist_credit c
       JOIN genre_tag gt ON gt.entity_type = 'release_group' AND gt.entity_id = c.entity_id
       JOIN genre g ON g.id = gt.genre_id
       WHERE c.entity_type = 'release_group' AND c.role = 'primary'
       GROUP BY c.artist_id, g.id`,
    ),
    // Who works on each artist's recordings, other than the artist.
    env.DB.prepare(
      `SELECT DISTINCT p.artist_id, o.artist_id AS person
       FROM artist_credit p
       JOIN artist_credit o ON o.entity_type = 'recording' AND o.entity_id = p.entity_id AND o.artist_id <> p.artist_id
       WHERE p.entity_type = 'recording' AND p.role = 'primary'`,
    ),
    env.DB.prepare(`SELECT id, name FROM artist`),
  ]);
  const name = new Map((names!.results as { id: string; name: string }[]).map((a) => [a.id, a.name]));
  const genreName = new Map<string, string>();
  const vectors = new Map<string, Map<string, number>>();
  for (const r of genres!.results as { artist_id: string; genre_id: string; name: string; n: number }[]) {
    genreName.set(r.genre_id, r.name);
    const v = vectors.get(r.artist_id) ?? new Map<string, number>();
    v.set(r.genre_id, r.n);
    vectors.set(r.artist_id, v);
  }
  const circles = new Map<string, Set<string>>();
  for (const r of people!.results as { artist_id: string; person: string }[]) {
    const s = circles.get(r.artist_id) ?? new Set<string>();
    s.add(r.person);
    circles.set(r.artist_id, s);
  }

  const mine = vectors.get(artistId) ?? new Map<string, number>();
  const myPeople = circles.get(artistId) ?? new Set<string>();
  const candidates = new Set([...vectors.keys(), ...circles.keys()]);
  const out: Kin[] = [];
  for (const other of candidates) {
    if (other === artistId || myPeople.has(other) || circles.get(other)?.has(artistId)) continue; // collaborators are shown elsewhere
    const theirs = vectors.get(other) ?? new Map<string, number>();
    const genreScore = cosine(mine, theirs);
    const shared = [...(circles.get(other) ?? [])].filter((p) => myPeople.has(p));
    // Two or three shared people is a strong sign; more adds little.
    const peopleScore = Math.min(1, shared.length / 3);
    const closeness = genreScore * 0.65 + peopleScore * 0.35;
    if (closeness < 0.25) continue;
    out.push({
      id: other,
      name: name.get(other) ?? 'Unknown',
      closeness,
      sharedGenres: [...mine.keys()].filter((g) => theirs.has(g)).sort((a, b) => (mine.get(b)! + theirs.get(b)!) - (mine.get(a)! + theirs.get(a)!)).slice(0, 3).map((g) => genreName.get(g)!),
      sharedPeople: shared.slice(0, 3).map((id) => ({ id, name: name.get(id) ?? 'Unknown' })),
    });
  }
  return out.sort((a, b) => b.closeness - a.closeness).slice(0, limit);
}
