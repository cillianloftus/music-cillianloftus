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
interface GenreVectors {
  /** artist → genre → how many of their releases carry it. */
  vectors: Record<string, Record<string, number>>;
  names: Record<string, string>;
}

/**
 * Every artist's genres, by how many of their releases carry each: one pass
 * a day for all artists. Worked out per artist (everyone sharing a genre,
 * with their whole profile) it was 186,000 rows for each artist page.
 */
function genreVectors(): Promise<GenreVectors> {
  return byDay('artist-genre-vectors:v1', async () => {
    const { results } = await env.DB.prepare(
      `SELECT c.artist_id, gt.genre_id, count(*) AS n
       FROM artist_credit c
       JOIN genre_tag gt ON gt.entity_type = 'release_group' AND gt.entity_id = c.entity_id
       WHERE c.entity_type = 'release_group' AND c.role = 'primary'
       GROUP BY c.artist_id, gt.genre_id`,
    ).all<{ artist_id: string; genre_id: string; n: number }>();
    const vectors: GenreVectors['vectors'] = {};
    for (const r of results) (vectors[r.artist_id] ??= {})[r.genre_id] = r.n;
    const ids = [...new Set(results.map((r) => r.genre_id))];
    const names = Object.fromEntries(
      (await env.DB.prepare(`SELECT id, name FROM genre WHERE id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(ids)).all<{ id: string; name: string }>()).results.map(
        (g) => [g.id, g.name],
      ),
    );
    return { vectors, names };
  });
}

async function findKin(artistId: string, limit: number): Promise<Kin[]> {
  // Who works on this artist's recordings, other than the artist.
  const MY_PEOPLE = `SELECT DISTINCT o.artist_id FROM artist_credit p
       JOIN artist_credit o ON o.entity_type = 'recording' AND o.entity_id = p.entity_id AND o.artist_id <> p.artist_id
       WHERE p.artist_id = ?1 AND p.entity_type = 'recording' AND p.role = 'primary'`;
  const [all, [myPeopleRows, sharing, workedFor]] = await Promise.all([genreVectors(), env.DB.batch([
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
  ])]);
  const genreName = new Map(Object.entries(all.names));
  // Only artists sharing a genre with this one can score on genres.
  const myGenres = new Set(Object.keys(all.vectors[artistId] ?? {}));
  const vectors = new Map<string, Map<string, number>>();
  for (const [artist, v] of Object.entries(all.vectors)) {
    if (artist === artistId || Object.keys(v).some((g) => myGenres.has(g))) vectors.set(artist, new Map(Object.entries(v)));
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
