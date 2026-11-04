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
  return words.map((word) => `"${word}"*`).join(' ');
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
  const ids = (result: D1Result<{ entity_id: string }> | undefined) => result?.results.map((r) => r.entity_id) ?? [];

  const [artistRows, albums, tracks] = await Promise.all([
    env.DB.prepare('SELECT id, name, disambiguation FROM artist WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(ids(artistIds)))
      .all<ArtistHit>(),
    releaseGroupsByIds(ids(albumIds), viewerId),
    hydrateTracks(ids(trackIds), viewerId),
  ]);

  // Keep the index's ranking.
  const order = (list: string[]) => new Map(list.map((id, i) => [id, i]));
  const artistOrder = order(ids(artistIds));
  const albumOrder = order(ids(albumIds));

  return {
    query,
    artists: artistRows.results.sort((a, b) => artistOrder.get(a.id)! - artistOrder.get(b.id)!),
    albums: albums.sort((a, b) => albumOrder.get(a.id)! - albumOrder.get(b.id)!),
    tracks,
  };
}
