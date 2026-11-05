/**
 * Looks an album up again everywhere it came from, to fill what is still
 * missing: each MusicBrainz edition is re-imported (which fills empty
 * fields and adds missing tracks and credits, and never overwrites), its
 * Spotify album is re-read, and its tracks are offered to Genius again
 * for writers. Anything edited by hand stays as it is.
 */

import { env } from 'cloudflare:workers';
import { enqueue } from './jobs/queue';

export async function refreshAlbum(albumId: string): Promise<string[]> {
  const album = await env.DB.prepare(`SELECT spotify_id FROM release_group WHERE id = ?`).bind(albumId).first<{ spotify_id: string | null }>();
  if (!album) return [];
  const { results } = await env.DB.prepare(`SELECT mbid FROM release WHERE release_group_id = ? AND mbid IS NOT NULL`)
    .bind(albumId)
    .all<{ mbid: string }>();

  // Spotify gets asked again on the next pass (after the imports land).
  await env.DB.prepare(`DELETE FROM lookup_log WHERE source IN ('spotify', 'deezer') AND entity_id = ?`).bind(albumId).run();
  // Tracks looked up on Genius before get another go.
  await env.DB.prepare(
    `DELETE FROM lookup_log WHERE source = 'genius' AND entity_id IN (
       SELECT t.recording_id FROM release x JOIN track t ON t.release_id = x.id WHERE x.release_group_id = ?)`,
  )
    .bind(albumId)
    .run();

  const jobs: string[] = [];
  for (const { mbid } of results) {
    jobs.push(await enqueue('import_release', { source: 'musicbrainz', target: { entity: 'release', mbid } }));
  }
  if (album.spotify_id) {
    jobs.push(await enqueue('import_release', { source: 'spotify', target: { kind: 'album', id: album.spotify_id } }));
  }
  return jobs;
}

/**
 * Every album an artist is the artist on, looked up again. Returns each
 * album's title with the jobs queued for it, for the progress tray.
 */
export async function refreshArtist(artistId: string): Promise<{ title: string; jobs: string[] }[]> {
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.title FROM artist_credit c JOIN release_group g ON g.id = c.entity_id
     WHERE c.artist_id = ? AND c.entity_type = 'release_group' AND c.role = 'primary'
     ORDER BY g.first_release_date DESC`,
  )
    .bind(artistId)
    .all<{ id: string; title: string }>();
  const out: { title: string; jobs: string[] }[] = [];
  for (const album of results) {
    const jobs = await refreshAlbum(album.id);
    if (jobs.length) out.push({ title: album.title, jobs });
  }
  return out;
}

/**
 * The whole library looked up again: every album re-queued at its sources,
 * every artist marked for a fresh lookup (details, bio, pictures), and the
 * Genius, Deezer, Spotify and Wikipedia memory of what was already asked
 * cleared so the nightly passes ask again. Fills gaps only, as always.
 * Returns how many jobs were queued.
 */
export async function refreshEverything(): Promise<number> {
  const { results } = await env.DB.prepare(`SELECT id FROM release_group ORDER BY created_at`).all<{ id: string }>();
  let queued = 0;
  for (const { id } of results) queued += (await refreshAlbum(id)).length;
  await env.DB.batch([
    env.DB.prepare(`UPDATE artist SET enriched_at = NULL`),
    env.DB.prepare(`DELETE FROM lookup_log`),
  ]);
  return queued;
}
