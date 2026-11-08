/**
 * Plain search across artists, albums and tracks. Not model-backed: a
 * full-text prefix match (migrations/0008), fast enough to run per
 * keystroke.
 */

import { env } from 'cloudflare:workers';
import { releaseGroupsByIds, type ReleaseGroupSummary } from './catalogue';
import { hydrateTracks, type TrackResult } from './query/run';

export const MIN_QUERY_LENGTH = 2;
const PER_KIND = 8;

export interface ArtistHit {
  id: string;
  name: string;
  disambiguation: string | null;
  /** Releases credited to them, and a cover to show beside the name. */
  releases: number;
  art_key: string | null;
}

export interface SearchResults {
  query: string;
  artists: ArtistHit[];
  albums: ReleaseGroupSummary[];
  tracks: TrackResult[];
}

/**
 * Turns typed text into an FTS5 query: every word must match as a prefix.
 * Each word is quoted, so nothing typed is read as FTS syntax.
 */
export function toMatchQuery(input: string): string | null {
  const words = input
    .normalize('NFKC')
    // Apostrophes are removed, not split on, matching the index (0009).
    .replace(/['’‘ʼ]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  if (words.join('').length < MIN_QUERY_LENGTH) return null;
  const each = words.map((word) => `"${word}"*`).join(' ');
  // Or the whole thing squashed, against the squashed names (0044): "kaan"
  // finds K.A.A.N., "acdc" AC/DC, "asap rocky" A$AP Rocky.
  const whole = squash(input);
  return whole.length >= MIN_QUERY_LENGTH && (words.length > 1 || whole !== words[0]) ? `(${each}) OR "${whole}"*` : each;
}

/** A name with punctuation and spaces taken out and $ read as s, as indexed (0044). */
export function squash(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\$/g, 's')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Edits (insert, delete, change, swap two) to turn a into b, giving up past max. */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, before[j - 2]! + 1);
      current[j] = d;
      best = Math.min(best, d);
    }
    if (best > max) return max + 1;
    before = previous;
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * Near misses, for a kind the plain search found nothing of: names sharing
 * the typed text's first letters, within a typo or two of it (one for a
 * short word, two for a longer). "quadecca" finds Quadeca. Only names
 * beginning alike are looked at, so it stays a small read.
 */
async function nearMisses(input: string, kind: string): Promise<string[]> {
  const typed = squash(input).toLowerCase();
  if (typed.length < 4) return [];
  const allowed = typed.length >= 7 ? 2 : 1;
  const { results } = await env.DB.prepare(
    `SELECT entity_id, name FROM search_index WHERE search_index MATCH ?1 AND kind = ?2 LIMIT 300`,
  )
    .bind(`"${typed.slice(0, 3)}"*`, kind)
    .all<{ entity_id: string; name: string }>();
  const scored = results
    .map((r) => {
      const words = [squash(r.name), ...r.name.split(/\s+/).map(squash)].map((w) => w.toLowerCase()).filter(Boolean);
      // Whole names and names still being typed (the same length as what is typed so far).
      const distance = Math.min(...words.flatMap((w) => [editDistance(typed, w, allowed), editDistance(typed, w.slice(0, typed.length), allowed)]));
      return { id: r.entity_id, distance };
    })
    .filter((r) => r.distance <= allowed)
    .sort((a, b) => a.distance - b.distance);
  return [...new Set(scored.map((r) => r.id))].slice(0, PER_KIND);
}

export async function search(input: string, viewerId: string | null): Promise<SearchResults> {
  const query = input.trim();
  const match = toMatchQuery(query);
  if (!match) return { query, artists: [], albums: [], tracks: [] };

  const ranked = (kind: string) =>
    env.DB.prepare(
      `SELECT entity_id FROM search_index
       WHERE search_index MATCH ?1 AND kind = ?2
       ORDER BY rank LIMIT ?3`,
    ).bind(match, kind, PER_KIND);

  const [artistIds, albumIds, trackIds] = await env.DB.batch<{ entity_id: string }>([
    ranked('artist'),
    ranked('release_group'),
    ranked('recording'),
  ]);
  // An artist can match by name and by an alias: keep each once, at its best rank.
  const found = (result: D1Result<{ entity_id: string }> | undefined) => [...new Set(result?.results.map((r) => r.entity_id) ?? [])];
  // A kind with nothing found tries near misses (a typo or two) instead.
  const orNear = async (result: D1Result<{ entity_id: string }> | undefined, kind: string) => {
    const exact = found(result);
    return exact.length ? exact : nearMisses(query, kind);
  };
  const [artistList, albumList, trackList] = await Promise.all([
    orNear(artistIds, 'artist'),
    orNear(albumIds, 'release_group'),
    orNear(trackIds, 'recording'),
  ]);

  // Searching for an artist should find their records too, not only titles
  // that happen to contain the name: the top artists' albums follow the
  // title matches.
  const topArtists = artistList.slice(0, 2);
  const byArtist = topArtists.length
    ? (
        await env.DB.prepare(
          `SELECT DISTINCT c.entity_id AS id FROM artist_credit c
           JOIN release_group g ON g.id = c.entity_id
           WHERE c.entity_type = 'release_group' AND c.role = 'primary'
             AND c.artist_id IN (SELECT value FROM json_each(?))
             AND (coalesce(g.official, 1) = 1 OR g.keep_unofficial = 1)
           ORDER BY g.type NOT IN ('album', 'mixtape'), g.first_release_date DESC LIMIT ?`,
        )
          .bind(JSON.stringify(topArtists), PER_KIND)
          .all<{ id: string }>()
      ).results.map((r) => r.id)
    : [];
  // Bootlegs waiting to be cleared stay out of search, as off artist pages.
  const titleMatches = albumList;
  const official = titleMatches.length
    ? new Set(
        (
          await env.DB.prepare(
            `SELECT id FROM release_group WHERE id IN (SELECT value FROM json_each(?)) AND (coalesce(official, 1) = 1 OR keep_unofficial = 1)`,
          )
            .bind(JSON.stringify(titleMatches))
            .all<{ id: string }>()
        ).results.map((r) => r.id),
      )
    : new Set<string>();
  const albumIdList = [...new Set([...titleMatches.filter((id) => official.has(id)), ...byArtist])].slice(0, PER_KIND + 4);

  const [artistRows, albums, tracks] = await Promise.all([
    env.DB.prepare(
      `SELECT a.id, a.name, a.disambiguation,
              (SELECT count(*) FROM artist_credit c JOIN release_group g ON g.id = c.entity_id
               WHERE c.artist_id = a.id AND c.entity_type = 'release_group' AND c.role = 'primary'
                 AND (coalesce(g.official, 1) = 1 OR g.keep_unofficial = 1)) AS releases,
              (SELECT r.art_key FROM artist_credit c
               JOIN v_release_group_canonical gc ON gc.release_group_id = c.entity_id
               JOIN release r ON r.id = gc.release_id
               JOIN release_group g ON g.id = c.entity_id
               WHERE c.artist_id = a.id AND c.entity_type = 'release_group' AND c.role = 'primary' AND r.art_key IS NOT NULL
               ORDER BY g.first_release_date DESC LIMIT 1) AS art_key
       FROM artist a WHERE a.id IN (SELECT value FROM json_each(?))`,
    )
      .bind(JSON.stringify(artistList))
      .all<ArtistHit>(),
    releaseGroupsByIds(albumIdList, viewerId),
    hydrateTracks(trackList, viewerId),
  ]);

  // Keep the index's ranking.
  const order = (list: string[]) => new Map(list.map((id, i) => [id, i]));
  const artistOrder = order(artistList);
  const albumOrder = order(albumIdList);

  return {
    query,
    artists: artistRows.results.sort((a, b) => artistOrder.get(a.id)! - artistOrder.get(b.id)!),
    albums: albums.sort((a, b) => albumOrder.get(a.id)! - albumOrder.get(b.id)!),
    tracks,
  };
}
