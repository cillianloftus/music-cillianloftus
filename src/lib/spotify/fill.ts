/**
 * Everything Spotify's Web API still gives about an album, used to fill
 * gaps: the release date (and its precision), each track's length, and
 * each track's ISRC. Fill only: nothing set by an import or by hand is
 * replaced.
 *
 * What it cannot give: songwriting and production credits (the Web API has
 * never had them; the app reads a private endpoint) and, since February
 * 2026, the label. Those come from MusicBrainz, Genius or by hand.
 */

import { env } from 'cloudflare:workers';
import { fetchSpotifyAlbum, type Getter } from './album';

export interface SpotifyFill {
  date: boolean;
  lengths: number;
  isrcs: number;
}

export async function fillFromSpotify(spotify: Getter, albumId: string): Promise<SpotifyFill> {
  const report: SpotifyFill = { date: false, lengths: 0, isrcs: 0 };
  const row = await env.DB.prepare(
    `SELECT g.spotify_id, g.first_release_date, v.release_id
     FROM release_group g LEFT JOIN v_release_group_canonical v ON v.release_group_id = g.id WHERE g.id = ?`,
  )
    .bind(albumId)
    .first<{ spotify_id: string | null; first_release_date: string | null; release_id: string | null }>();
  if (!row?.spotify_id) return report;
  const album = await fetchSpotifyAlbum(spotify, row.spotify_id);
  const db = env.DB;
  const precision = album.release_date_precision;
  const statements: D1PreparedStatement[] = [];

  if (!row.first_release_date && album.release_date) {
    statements.push(
      db.prepare(
        `UPDATE release_group SET first_release_date = ?2, date_precision = ?3
         WHERE id = ?1 AND first_release_date IS NULL
           AND NOT EXISTS (SELECT 1 FROM field_override o WHERE o.entity_type = 'release_group' AND o.entity_id = ?1 AND o.field = 'first_release_date')`,
      ).bind(albumId, album.release_date, precision),
    );
    report.date = true;
  }

  // Tracks, by Spotify id where linked, else by place on the standard edition.
  const rows = album.tracks.items.map((t) => ({ id: t.id, disc: t.disc_number || 1, position: t.track_number, length: t.duration_ms, isrc: t.isrc ?? null }));
  const { results } = await db
    .prepare(
      `SELECT r.id, r.spotify_id, r.length_ms, r.isrc, t.disc, t.position FROM track t JOIN recording r ON r.id = t.recording_id WHERE t.release_id = ?`,
    )
    .bind(row.release_id ?? '')
    .all<{ id: string; spotify_id: string | null; length_ms: number | null; isrc: string | null; disc: number; position: number }>();
  for (const rec of results) {
    const match = rows.find((t) => t.id === rec.spotify_id) ?? rows.find((t) => t.disc === rec.disc && t.position === rec.position);
    if (!match) continue;
    if (rec.length_ms == null && match.length) {
      statements.push(db.prepare(`UPDATE recording SET length_ms = ? WHERE id = ? AND length_ms IS NULL`).bind(match.length, rec.id));
      report.lengths += 1;
    }
    if (!rec.isrc) {
      // Album listings omit ISRCs; one track lookup each, only where missing.
      const isrc = match.isrc ?? (await spotify.get<{ external_ids?: { isrc?: string } }>(`/tracks/${match.id}`).catch(() => null))?.external_ids?.isrc ?? null;
      if (isrc && /^[A-Za-z0-9]{12}$/.test(isrc)) {
        statements.push(db.prepare(`UPDATE recording SET isrc = ? WHERE id = ? AND isrc IS NULL`).bind(isrc.toUpperCase(), rec.id));
        report.isrcs += 1;
      }
    }
  }
  if (statements.length) await db.batch(statements);
  await db
    .prepare(
      `INSERT INTO lookup_log (source, entity_id, found) VALUES ('spotify', ?, 1)
       ON CONFLICT (source, entity_id) DO UPDATE SET found = 1, looked_at = excluded.looked_at`,
    )
    .bind(albumId)
    .run();
  return report;
}

/** Albums linked to Spotify not filled from it in the last month, until the budget runs out. */
export async function fillAlbumsFromSpotify(spotify: Getter, { budgetMs, limit = 20 }: { budgetMs: number; limit?: number }): Promise<number> {
  const deadline = Date.now() + budgetMs;
  const { results } = await env.DB.prepare(
    `SELECT g.id FROM release_group g
     WHERE g.spotify_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM lookup_log l WHERE l.source = 'spotify' AND l.entity_id = g.id AND l.looked_at > datetime('now', '-30 days'))
     LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string }>();
  let done = 0;
  for (const { id } of results) {
    if (Date.now() > deadline) break;
    await fillFromSpotify(spotify, id).catch((error) => console.warn('Spotify fill failed', id, error));
    done += 1;
  }
  return done;
}
