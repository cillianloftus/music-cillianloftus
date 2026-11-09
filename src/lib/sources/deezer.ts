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

interface DeezerTrackRow {
  id: number;
  title: string;
  title_short?: string;
  isrc?: string;
  track_position: number;
  disk_number: number;
  rank?: number;
  explicit_lyrics?: boolean;
}

interface DeezerTrackDetail {
  bpm?: number;
  gain?: number;
}

export interface SoundFill {
  /** Library tracks matched to a Deezer track. */
  matched: number;
  /** Of those, how many got a tempo. */
  tempos: number;
}

/**
 * Each track on an album's standard edition matched to Deezer's (same disc
 * and position with the same title, or the same ISRC), and filled from it:
 * tempo and loudness (one request per track, only for tracks without a
 * tempo yet), explicit, Deezer's rank and id, and a missing ISRC.
 */
export async function fillSoundFromDeezer(albumId: string, fetcher: Fetcher = fetch): Promise<SoundFill> {
  const report: SoundFill = { matched: 0, tempos: 0 };
  const row = await env.DB.prepare(
    `SELECT g.title, r.id AS release_id, r.barcode,
            (SELECT a.name FROM artist_credit c JOIN artist a ON a.id = c.artist_id
             WHERE c.entity_type = 'release_group' AND c.entity_id = g.id AND c.role = 'primary' ORDER BY c.position LIMIT 1) AS artist
     FROM release_group g
     JOIN v_release_group_canonical v ON v.release_group_id = g.id
     JOIN release r ON r.id = v.release_id
     WHERE g.id = ?`,
  )
    .bind(albumId)
    .first<{ title: string; release_id: string; barcode: string | null; artist: string | null }>();
  const album = row?.artist ? await findDeezerAlbum({ artist: row.artist, title: row.title, barcode: row.barcode }, fetcher) : null;

  const statements: D1PreparedStatement[] = [];
  if (row && album) {
    const [theirs, { results: ours }] = await Promise.all([
      get<{ data: DeezerTrackRow[] }>(`/album/${album.id}/tracks?limit=300`, fetcher),
      env.DB.prepare(
        `SELECT t.disc, t.position, r.id, coalesce(t.title_on_release, r.title) AS title, r.isrc, r.bpm
         FROM track t JOIN recording r ON r.id = t.recording_id WHERE t.release_id = ?`,
      )
        .bind(row.release_id)
        .all<{ disc: number; position: number; id: string; title: string; isrc: string | null; bpm: number | null }>(),
    ]);
    for (const track of ours) {
      const title = normaliseTitle(track.title);
      const match = theirs?.data.find(
        (d) =>
          (track.isrc && d.isrc === track.isrc) ||
          (d.disk_number === track.disc &&
            d.track_position === track.position &&
            [d.title, d.title_short].some((t) => t && normaliseTitle(t) === title)),
      );
      if (!match) continue;
      report.matched += 1;
      const detail = track.bpm === null ? await get<DeezerTrackDetail>(`/track/${match.id}`, fetcher) : null;
      // Deezer gives 0 for a tempo it does not know.
      const bpm = detail?.bpm && detail.bpm > 0 ? Math.round(detail.bpm * 10) / 10 : null;
      if (bpm !== null) report.tempos += 1;
      statements.push(
        env.DB.prepare(
          `UPDATE recording SET
             deezer_id = ?2, deezer_rank = ?3,
             explicit = coalesce(explicit, ?4),
             isrc = coalesce(isrc, ?5),
             bpm = coalesce(bpm, ?6),
             loudness = coalesce(loudness, ?7)
           WHERE id = ?1`,
        ).bind(
          track.id,
          match.id,
          match.rank ?? null,
          match.explicit_lyrics === undefined ? null : match.explicit_lyrics ? 1 : 0,
          match.isrc && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(match.isrc) ? match.isrc : null,
          bpm,
          typeof detail?.gain === 'number' ? detail.gain : null,
        ),
      );
    }
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO lookup_log (source, entity_id, found) VALUES ('deezer-tracks', ?, ?)
       ON CONFLICT (source, entity_id) DO UPDATE SET found = excluded.found, looked_at = excluded.looked_at`,
    ).bind(albumId, report.matched > 0 ? 1 : 0),
  );
  await env.DB.batch(statements);
  return report;
}

/**
 * Albums whose tracks have not been matched on Deezer (never, or not in
 * three months when nothing matched), newest first, until the budget runs
 * out. Answers how many albums it looked at and how many are left.
 */
export async function fillAlbumSoundFromDeezer({
  budgetMs,
  limit = 40,
  fetcher = fetch,
}: {
  budgetMs: number;
  limit?: number;
  fetcher?: Fetcher;
}): Promise<{ albums: number; matched: number; tempos: number; left: number }> {
  const deadline = Date.now() + budgetMs;
  const waiting = `FROM release_group g
     WHERE NOT EXISTS (SELECT 1 FROM lookup_log l WHERE l.source = 'deezer-tracks' AND l.entity_id = g.id
                       AND (l.found = 1 OR l.looked_at > datetime('now', '-90 days')))`;
  const { results } = await env.DB.prepare(`SELECT g.id ${waiting} ORDER BY g.created_at DESC LIMIT ?`)
    .bind(limit)
    .all<{ id: string }>();
  const report = { albums: 0, matched: 0, tempos: 0, left: 0 };
  for (const { id } of results) {
    if (Date.now() > deadline) break;
    try {
      const done = await fillSoundFromDeezer(id, fetcher);
      report.matched += done.matched;
      report.tempos += done.tempos;
    } catch (error) {
      console.warn('Deezer tracks failed', id, error);
    }
    report.albums += 1;
  }
  report.left = (await env.DB.prepare(`SELECT count(*) AS n ${waiting}`).first<{ n: number }>())?.n ?? 0;
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
