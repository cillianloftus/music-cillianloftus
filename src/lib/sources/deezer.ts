/**
 * Deezer, for what Spotify stopped giving and MusicBrainz often lacks for
 * small releases: the label, the barcode (UPC) and the release date. Free,
 * no key. Found by barcode when one is known, otherwise by artist and title,
 * accepted only when both match (ignoring case and punctuation).
 *
 * Fill only: a field already set, or edited by hand, is left alone.
 */

import { env } from 'cloudflare:workers';
import { normaliseName, normaliseTitle } from '../text';

const API = 'https://api.deezer.com';

export interface DeezerAlbum {
  id: number;
  title: string;
  label?: string;
  upc?: string;
  release_date?: string;
  artist?: { name: string };
  error?: unknown;
}

type Fetcher = typeof fetch;

async function get<T>(path: string, fetcher: Fetcher): Promise<T | null> {
  const res = await fetcher(`${API}${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) return null;
  const body = (await res.json()) as T & { error?: unknown };
  return body.error ? null : body;
}

export async function findDeezerAlbum(
  query: { artist: string; title: string; barcode: string | null },
  fetcher: Fetcher = fetch,
): Promise<DeezerAlbum | null> {
  if (query.barcode) {
    const byCode = await get<DeezerAlbum>(`/album/upc:${query.barcode}`, fetcher);
    if (byCode?.id) return byCode;
  }
  const search = await get<{ data: { id: number; title: string; artist: { name: string } }[] }>(
    `/search/album?q=${encodeURIComponent(`artist:"${query.artist}" album:"${query.title}"`)}`,
    fetcher,
  );
  const title = normaliseTitle(query.title);
  const artist = normaliseName(query.artist);
  const hit = search?.data.find((a) => normaliseTitle(a.title) === title && normaliseName(a.artist.name) === artist);
  return hit ? get<DeezerAlbum>(`/album/${hit.id}`, fetcher) : null;
}

export interface DeezerFill {
  label: boolean;
  barcode: boolean;
  date: boolean;
}

/** Fills an album's standard edition (label, barcode) and its date from Deezer. */
export async function fillFromDeezer(albumId: string, fetcher: Fetcher = fetch): Promise<DeezerFill> {
  const report: DeezerFill = { label: false, barcode: false, date: false };
  const row = await env.DB.prepare(
    `SELECT g.title, g.first_release_date, r.id AS release_id, r.label, r.barcode,
            (SELECT a.name FROM artist_credit c JOIN artist a ON a.id = c.artist_id
             WHERE c.entity_type = 'release_group' AND c.entity_id = g.id AND c.role = 'primary' ORDER BY c.position LIMIT 1) AS artist
     FROM release_group g
     JOIN v_release_group_canonical v ON v.release_group_id = g.id
     JOIN release r ON r.id = v.release_id
     WHERE g.id = ?`,
  )
    .bind(albumId)
    .first<{ title: string; first_release_date: string | null; release_id: string; label: string | null; barcode: string | null; artist: string | null }>();
  if (!row?.artist) return report;

  const album = await findDeezerAlbum({ artist: row.artist, title: row.title, barcode: row.barcode }, fetcher);
  const db = env.DB;
  const untouched = (entity: string, field: string, idParam: string) =>
    `NOT EXISTS (SELECT 1 FROM field_override o WHERE o.entity_type = '${entity}' AND o.entity_id = ${idParam} AND o.field = '${field}')`;
  const statements: D1PreparedStatement[] = [];
  if (album) {
    if (!row.label && album.label) {
      statements.push(
        db.prepare(`UPDATE release SET label = ?2 WHERE id = ?1 AND label IS NULL AND ${untouched('release', 'label', '?1')}`).bind(row.release_id, album.label),
      );
      report.label = true;
    }
    if (!row.barcode && album.upc && /^\d{8,14}$/.test(album.upc)) {
      statements.push(db.prepare(`UPDATE release SET barcode = ?2 WHERE id = ?1 AND barcode IS NULL`).bind(row.release_id, album.upc));
      report.barcode = true;
    }
    if (!row.first_release_date && album.release_date && /^\d{4}-\d{2}-\d{2}$/.test(album.release_date)) {
      statements.push(
        db.prepare(
          `UPDATE release_group SET first_release_date = ?2, date_precision = 'day'
           WHERE id = ?1 AND first_release_date IS NULL AND ${untouched('release_group', 'first_release_date', '?1')}`,
        ).bind(albumId, album.release_date),
      );
      report.date = true;
    }
  }
  statements.push(
    db.prepare(
      `INSERT INTO lookup_log (source, entity_id, found) VALUES ('deezer', ?, ?)
       ON CONFLICT (source, entity_id) DO UPDATE SET found = excluded.found, looked_at = excluded.looked_at`,
    ).bind(albumId, album ? 1 : 0),
  );
  await db.batch(statements);
  return report;
}

/** Albums not asked about in a month, until the budget runs out. */
export async function fillAlbumsFromDeezer({ budgetMs, limit = 30 }: { budgetMs: number; limit?: number }): Promise<number> {
  const deadline = Date.now() + budgetMs;
  const { results } = await env.DB.prepare(
    `SELECT g.id FROM release_group g
     WHERE NOT EXISTS (SELECT 1 FROM lookup_log l WHERE l.source = 'deezer' AND l.entity_id = g.id AND l.looked_at > datetime('now', '-30 days'))
     ORDER BY g.created_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string }>();
  let done = 0;
  for (const { id } of results) {
    if (Date.now() > deadline) break;
    await fillFromDeezer(id).catch((error) => console.warn('Deezer fill failed', id, error));
    done += 1;
  }
  return done;
}
