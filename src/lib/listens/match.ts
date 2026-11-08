/**
 * Which catalogue recording a listened track is, if any. One matcher for
 * every source: by Spotify id, then MusicBrainz recording id, then artist
 * (any credited name, "A feat. B" split) and title, preferring the
 * recording on the album the source named. A title alone never matches.
 */

import { env } from 'cloudflare:workers';
import { normaliseName, normaliseTitle } from '../text';
import type { TrackNaming } from './keys';

interface IndexRow {
  id: string;
  title: string;
  mbid: string | null;
  spotify_id: string | null;
  length_ms: number | null;
  artists: string | null;
  albums: string | null;
}

export interface CatalogueIndex {
  bySpotify: Map<string, IndexRow>;
  byMbid: Map<string, IndexRow>;
  byName: Map<string, IndexRow[]>;
}

/** Splits "A feat. B", "A & B", "A, B" into the names a credit might use. */
export function artistNames(credit: string): string[] {
  const whole = normaliseName(credit);
  const parts = credit
    .split(/\s+(?:feat\.?|ft\.?|featuring|with|x|&|and|vs\.?)\s+|,\s*|\s*;\s*/i)
    .map((p) => normaliseName(p))
    .filter(Boolean);
  return [...new Set([whole, ...parts])];
}

export function indexOf(rows: IndexRow[]): CatalogueIndex {
  const bySpotify = new Map<string, IndexRow>();
  const byMbid = new Map<string, IndexRow>();
  const byName = new Map<string, IndexRow[]>();
  for (const row of rows) {
    if (row.spotify_id) bySpotify.set(row.spotify_id, row);
    if (row.mbid) byMbid.set(row.mbid, row);
    const title = normaliseTitle(row.title);
    for (const artist of JSON.parse(row.artists ?? '[]') as string[]) {
      const key = `${normaliseName(artist)}\u0000${title}`;
      const list = byName.get(key);
      if (list) list.push(row);
      else byName.set(key, [row]);
    }
  }
  return { bySpotify, byMbid, byName };
}

/** Every recording, keyed every way a listen might name it. One pass over the catalogue. */
export async function catalogueIndex(): Promise<CatalogueIndex> {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.title, r.mbid, r.spotify_id, r.length_ms,
            (SELECT json_group_array(a.name) FROM artist_credit c JOIN artist a ON a.id = c.artist_id
             WHERE c.entity_type = 'recording' AND c.entity_id = r.id AND c.role IN ('primary', 'featured')) AS artists,
            (SELECT json_group_array(g.title) FROM track t JOIN release x ON x.id = t.release_id
             JOIN release_group g ON g.id = x.release_group_id WHERE t.recording_id = r.id) AS albums
     FROM recording r`,
  ).all<IndexRow>();
  return indexOf(results);
}

export function matchTrack(index: CatalogueIndex, t: TrackNaming): IndexRow | null {
  if (t.spotify_id) {
    const exact = index.bySpotify.get(t.spotify_id);
    if (exact) return exact;
  }
  if (t.mbid) {
    const exact = index.byMbid.get(t.mbid);
    if (exact) return exact;
  }
  const title = normaliseTitle(t.title);
  const album = t.album ? normaliseTitle(t.album) : null;
  for (const artist of artistNames(t.artist)) {
    const candidates = index.byName.get(`${artist}\u0000${title}`);
    if (!candidates?.length) continue;
    const onAlbum = album ? candidates.find((c) => (JSON.parse(c.albums ?? '[]') as string[]).some((a) => normaliseTitle(a) === album)) : undefined;
    return onAlbum ?? candidates[0]!;
  }
  return null;
}
