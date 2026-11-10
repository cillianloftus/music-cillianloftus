/**
 * Critics' lists, awards and series (migration 0055): each with the albums
 * in the library on it, in its own order where it has one.
 */

import { env } from 'cloudflare:workers';
import { releaseGroupsByIds, type ReleaseGroupSummary } from './catalogue';

export interface SeriesSummary {
  id: string;
  name: string;
  type: string | null;
  /** Albums in the library on it. */
  albums: number;
}

/** Every list with at least one album in the library, the fullest first. */
export async function allSeries(): Promise<SeriesSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.name, s.type, count(*) AS albums
     FROM series s JOIN release_group_series x ON x.series_id = s.id
     GROUP BY s.id
     ORDER BY albums DESC, s.name`,
  ).all<SeriesSummary>();
  return results;
}

export interface SeriesDetail {
  id: string;
  name: string;
  type: string | null;
  mbid: string | null;
}

export function seriesDetail(id: string): Promise<SeriesDetail | null> {
  return env.DB.prepare(`SELECT id, name, type, mbid FROM series WHERE id = ?`).bind(id).first<SeriesDetail>();
}

export interface SeriesEntry {
  album: ReleaseGroupSummary;
  /** Its place or year there ("42", "1998 winner"), when given. */
  number: string | null;
}

/**
 * The library's albums on a list: by their number when it is a plain place
 * (No. 1 first), else newest first.
 */
export async function seriesAlbums(id: string, viewerId: string | null): Promise<SeriesEntry[]> {
  const { results } = await env.DB.prepare(`SELECT release_group_id AS id, number FROM release_group_series WHERE series_id = ?`)
    .bind(id)
    .all<{ id: string; number: string | null }>();
  const albums = new Map((await releaseGroupsByIds(results.map((r) => r.id), viewerId)).map((a) => [a.id, a]));
  const place = (n: string | null) => (n && /^\d{1,4}$/.test(n) ? Number(n) : null);
  return results
    .flatMap((r) => (albums.has(r.id) ? [{ album: albums.get(r.id)!, number: r.number }] : []))
    .sort((a, b) => {
      const x = place(a.number);
      const y = place(b.number);
      if (x !== null && y !== null) return x - y;
      if (x !== null) return -1;
      if (y !== null) return 1;
      return (b.album.first_release_date ?? '').localeCompare(a.album.first_release_date ?? '');
    });
}
