/**
 * What an album page shows from MusicBrainz's second look (migration 0055):
 * each edition's labels with catalogue numbers and its packaging, the lists
 * and awards the album is part of, and MusicBrainz's community rating.
 */

import { env } from 'cloudflare:workers';

export interface EditionLabel {
  release_id: string;
  label_id: string;
  name: string;
  catalog_number: string | null;
}

export interface AlbumList {
  series_id: string;
  name: string;
  /** "Release group award", "Release group series"… */
  type: string | null;
  /** Its place there ("42"), or the year for an award ("1998 winner"). */
  number: string | null;
}

export interface AlbumExtras {
  labels: EditionLabel[];
  packaging: Map<string, string>;
  lists: AlbumList[];
  rating: { value: number; votes: number } | null;
}

export async function albumExtras(albumId: string): Promise<AlbumExtras> {
  const [labels, packaging, lists, rating] = await env.DB.batch([
    env.DB.prepare(
      `SELECT rl.release_id, l.id AS label_id, l.name, rl.catalog_number
       FROM release x JOIN release_label rl ON rl.release_id = x.id JOIN label l ON l.id = rl.label_id
       WHERE x.release_group_id = ?
       ORDER BY l.name`,
    ).bind(albumId),
    env.DB.prepare(`SELECT id, packaging FROM release WHERE release_group_id = ? AND packaging IS NOT NULL`).bind(albumId),
    env.DB.prepare(
      `SELECT s.id AS series_id, s.name, s.type, x.number
       FROM release_group_series x JOIN series s ON s.id = x.series_id
       WHERE x.release_group_id = ?
       -- Awards first, then lists, each by name.
       ORDER BY s.type = 'Release group award' DESC, s.name`,
    ).bind(albumId),
    env.DB.prepare(`SELECT mb_rating AS value, mb_rating_votes AS votes FROM release_group WHERE id = ? AND mb_rating IS NOT NULL`).bind(albumId),
  ]);
  const one = rating!.results[0] as { value: number; votes: number } | undefined;
  return {
    labels: labels!.results as unknown as EditionLabel[],
    packaging: new Map((packaging!.results as { id: string; packaging: string }[]).map((p) => [p.id, p.packaging])),
    lists: lists!.results as unknown as AlbumList[],
    rating: one ?? null,
  };
}

/** How a place in a list or an award reads: "No. 42", "1998 winner", "2011.11.14", or nothing. */
export function placeIn(list: AlbumList): string | null {
  if (!list.number) return null;
  // A plain number that is not a year is a place on the list, whatever kind
  // of series MusicBrainz files it as (some ranked lists are filed as awards).
  return /^\d{1,3}$/.test(list.number) ? `No. ${list.number}` : list.number;
}
