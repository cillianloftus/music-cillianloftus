/**
 * Artists close to another, from the library alone: how alike their genres
 * are (cosine over how often each genre tags their releases) and how many
 * of the same people work with both (writers, producers, engineers, guests).
 * Each comes with the reason, so "close to" is never unexplained.
 */

import { env } from 'cloudflare:workers';
import { byDay } from './library-cache';

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

/** Worked out once a day per artist: one import barely moves it, and it is dear (byDay). */
export async function kinOf(artistId: string, limit = 6): Promise<Kin[]> {
  return byDay(`kin:v2:${artistId}:${limit}`, () => findKin(artistId, limit));
}

/**
 * Only the artists that could be close: those sharing a genre or a person
 * with this one (anyone sharing neither scores nothing). Reading every
 * artist's genres and every collaboration was 150,000 rows per artist.
 */
async function findKin(artistId: string, limit: number): Promise<Kin[]> {
  // Each artist's genres, by how many of their releases carry each.
  const VECTOR = `SELECT c.artist_id, g.id AS genre_id, g.name, count(*) AS n
       FROM artist_credit c
       JOIN genre_tag gt ON gt.entity_type = 'release_group' AND gt.entity_id = c.entity_id
       JOIN genre g ON g.id = gt.genre_id
       WHERE c.entity_type = 'release_group' AND c.role = 'primary'`;
  // Who works on this artist's recordings, other than the artist.
  const MY_PEOPLE = `SELECT DISTINCT o.artist_id FROM artist_credit p
       JOIN artist_credit o ON o.entity_type = 'recording' AND o.entity_id = p.entity_id AND o.artist_id <> p.artist_id
       WHERE p.artist_id = ?1 AND p.entity_type = 'recording' AND p.role = 'primary'`;
  const [genres, myPeopleRows, sharing, workedFor] = await env.DB.batch([
    // Every artist with a genre in common, with their whole genre count.
    env.DB.prepare(
      `${VECTOR}
         AND c.artist_id IN (
           SELECT c2.artist_id FROM genre_tag gt2
           JOIN artist_credit c2 ON c2.entity_type = 'release_group' AND c2.entity_id = gt2.entity_id AND c2.role = 'primary'
           WHERE gt2.entity_type = 'release_group'
             AND gt2.genre_id IN (SELECT gt3.genre_id FROM artist_credit c3
                                  JOIN genre_tag gt3 ON gt3.entity_type = 'release_group' AND gt3.entity_id = c3.entity_id
                                  WHERE c3.artist_id = ?1 AND c3.entity_type = 'release_group' AND c3.role = 'primary'))
       GROUP BY c.artist_id, g.id`,
    ).bind(artistId),
    env.DB.prepare(MY_PEOPLE).bind(artistId),
    // Other artists whose recordings have someone from this artist's circle.
    env.DB.prepare(
      `SELECT DISTINCT p.artist_id, o.artist_id AS person, a.name AS person_name
       FROM artist_credit o
       JOIN artist_credit p ON p.entity_type = 'recording' AND p.entity_id = o.entity_id AND p.role = 'primary' AND p.artist_id <> o.artist_id
       JOIN artist a ON a.id = o.artist_id
       WHERE o.entity_type = 'recording' AND o.artist_id IN (${MY_PEOPLE}) AND p.artist_id <> ?1`,
    ).bind(artistId),
    // Artists this one works for: collaborators, shown elsewhere.
    env.DB.prepare(
      `SELECT DISTINCT p.artist_id FROM artist_credit o
       JOIN artist_credit p ON p.entity_type = 'recording' AND p.entity_id = o.entity_id AND p.role = 'primary' AND p.artist_id <> o.artist_id
       WHERE o.artist_id = ?1 AND o.entity_type = 'recording'`,
    ).bind(artistId),
  ]);
  const genreName = new Map<string, string>();
  const vectors = new Map<string, Map<string, number>>();
  for (const r of genres!.results as { artist_id: string; genre_id: string; name: string; n: number }[]) {
    genreName.set(r.genre_id, r.name);
    const v = vectors.get(r.artist_id) ?? new Map<string, number>();
    v.set(r.genre_id, r.n);
    vectors.set(r.artist_id, v);
  }
  const myPeople = new Set((myPeopleRows!.results as { artist_id: string }[]).map((r) => r.artist_id));
  const personName = new Map<string, string>();
  const sharedWith = new Map<string, Set<string>>();
  for (const r of sharing!.results as { artist_id: string; person: string; person_name: string }[]) {
    personName.set(r.person, r.person_name);
    const s = sharedWith.get(r.artist_id) ?? new Set<string>();
    s.add(r.person);
    sharedWith.set(r.artist_id, s);
  }
  const collaborators = new Set((workedFor!.results as { artist_id: string }[]).map((r) => r.artist_id));

  const mine = vectors.get(artistId) ?? new Map<string, number>();
  const candidates = new Set([...vectors.keys(), ...sharedWith.keys()]);
  const out: Kin[] = [];
  for (const other of candidates) {
    if (other === artistId || myPeople.has(other) || collaborators.has(other)) continue; // collaborators are shown elsewhere
    const theirs = vectors.get(other) ?? new Map<string, number>();
    const genreScore = cosine(mine, theirs);
    const shared = [...(sharedWith.get(other) ?? [])].filter((p) => myPeople.has(p));
    // Two or three shared people is a strong sign; more adds little.
    const peopleScore = Math.min(1, shared.length / 3);
    const closeness = genreScore * 0.65 + peopleScore * 0.35;
    if (closeness < 0.25) continue;
    out.push({
      id: other,
      name: '',
      closeness,
      sharedGenres: [...mine.keys()].filter((g) => theirs.has(g)).sort((a, b) => (mine.get(b)! + theirs.get(b)!) - (mine.get(a)! + theirs.get(a)!)).slice(0, 3).map((g) => genreName.get(g)!),
      sharedPeople: shared.slice(0, 3).map((id) => ({ id, name: personName.get(id) ?? 'Unknown' })),
    });
  }
  const top = out.sort((a, b) => b.closeness - a.closeness).slice(0, limit);
  // Names for the few shown, not every candidate.
  if (top.length) {
    const names = new Map(
      (
        await env.DB.prepare(`SELECT id, name FROM artist WHERE id IN (SELECT value FROM json_each(?1))`)
          .bind(JSON.stringify(top.map((k) => k.id)))
          .all<{ id: string; name: string }>()
      ).results.map((a) => [a.id, a.name]),
    );
    for (const k of top) k.name = names.get(k.id) ?? 'Unknown';
  }
  return top;
}
