/**
 * Putting a song already in the library on an album by hand, from the
 * song's page: on the album's standard edition (the one its score counts),
 * at the end or at a track number, the songs from there on moved down one.
 * For releases made by hand around songs already here, and an album a
 * source left a song off.
 */

import { env } from 'cloudflare:workers';

export class AddToAlbumError extends Error {}

/** Albums the song could go on: its artist's, those it is not on yet. */
export async function albumsForSong(recordingId: string): Promise<{ id: string; title: string; year: string | null; type: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT g.id, g.title, substr(g.first_release_date, 1, 4) AS year, g.type
     FROM artist_credit rc
     JOIN artist_credit gc ON gc.artist_id = rc.artist_id AND gc.entity_type = 'release_group' AND gc.role = 'primary'
     JOIN release_group g ON g.id = gc.entity_id
     WHERE rc.entity_type = 'recording' AND rc.entity_id = ?1 AND rc.role = 'primary'
       AND NOT EXISTS (SELECT 1 FROM release x JOIN track t ON t.release_id = x.id WHERE x.release_group_id = g.id AND t.recording_id = ?1)
     ORDER BY g.first_release_date DESC, g.title`,
  )
    .bind(recordingId)
    .all<{ id: string; title: string; year: string | null; type: string }>();
  return results;
}

/**
 * Adds the song to the album's standard edition: at the end, or at the
 * given track number on disc 1 with the songs from there on moved down.
 * Returns the release it went on.
 */
export async function addToAlbum(recordingId: string, albumId: string, position: number | null = null): Promise<string> {
  const target = await env.DB.prepare(
    `SELECT coalesce(g.preferred_release_id, c.release_id) AS release_id,
            EXISTS (SELECT 1 FROM recording WHERE id = ?2) AS song
     FROM release_group g LEFT JOIN v_release_group_canonical c ON c.release_group_id = g.id
     WHERE g.id = ?1`,
  )
    .bind(albumId, recordingId)
    .first<{ release_id: string | null; song: number }>();
  if (!target?.song) throw new AddToAlbumError('That song is no longer in the library.');
  if (!target.release_id) throw new AddToAlbumError('That album has no edition to add a song to yet.');
  const releaseId = target.release_id;

  const on = await env.DB.prepare(`SELECT 1 AS yes FROM track WHERE release_id = ? AND recording_id = ?`).bind(releaseId, recordingId).first();
  if (on) throw new AddToAlbumError('It is already on that album.');

  const last = (await env.DB.prepare(`SELECT max(position) AS n FROM track WHERE release_id = ? AND disc = 1`).bind(releaseId).first<number>('n')) ?? 0;
  const at = position && position >= 1 && position <= last ? Math.round(position) : last + 1;
  const statements: D1PreparedStatement[] = [];
  if (at <= last) {
    // Make room: from the end backwards, so no two tracks ever share a number.
    const { results: after } = await env.DB.prepare(`SELECT id, position FROM track WHERE release_id = ? AND disc = 1 AND position >= ? ORDER BY position DESC`)
      .bind(releaseId, at)
      .all<{ id: string; position: number }>();
    for (const t of after) statements.push(env.DB.prepare(`UPDATE track SET position = ? WHERE id = ?`).bind(t.position + 1, t.id));
  }
  statements.push(
    env.DB.prepare(`INSERT INTO track (id, release_id, recording_id, disc, position) VALUES (?, ?, ?, 1, ?)`).bind(crypto.randomUUID(), releaseId, recordingId, at),
    // Album scores count it from now on: their caches follow the scores version.
    env.DB.prepare(`UPDATE app_setting SET value = CAST(value AS INTEGER) + 1 WHERE key = 'scores_version'`),
  );
  await env.DB.batch(statements);
  return releaseId;
}
