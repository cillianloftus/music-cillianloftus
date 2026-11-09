/**
 * Finding an edition's cover again, best source first: its own scan on the
 * Cover Art Archive, then its Spotify album, then (only if it is no other
 * edition's) the album-wide front.
 */

import { env } from 'cloudflare:workers';
import { ownerId } from './auth/user';
import { ART_SIZES, artKeyFor, storeCoverArt } from './import/coverart';
import { itunesCover } from './sources/itunes';
import { storeSpotifyArt } from './import/spotify';
import { fetchSpotifyAlbum } from './spotify/album';
import { connection, spotifyFor } from './spotify/client';

export type CoverSource = 'cover art archive' | 'itunes' | 'spotify' | null;

/** Stores the three derivatives from an image URL template, as the archive's are stored. */
async function storeFromTemplate(releaseId: string, url: (size: number) => string): Promise<boolean> {
  const bodies = await Promise.all(
    ART_SIZES.map(async (size) => {
      const res = await fetch(url(size));
      return res.ok ? res.arrayBuffer() : null;
    }),
  );
  if (bodies.some((b) => !b)) return false;
  const key = artKeyFor(releaseId);
  await Promise.all(ART_SIZES.map((size, i) => env.ASSET_STORE.put(`${key}/${size}.jpg`, bodies[i]!, { httpMetadata: { contentType: 'image/jpeg' } })));
  await env.DB.prepare(`UPDATE release SET art_key = ? WHERE id = ?`).bind(key, releaseId).run();
  return true;
}

export async function findCover(releaseId: string, { replace }: { replace: boolean }): Promise<CoverSource> {
  const row = await env.DB.prepare(
    `SELECT x.mbid, x.spotify_id, x.art_key, g.mbid AS group_mbid, g.spotify_id AS group_spotify_id,
            (SELECT c.release_id FROM v_release_group_canonical c WHERE c.release_group_id = g.id) AS standard_id
     FROM release x JOIN release_group g ON g.id = x.release_group_id WHERE x.id = ?`,
  )
    .bind(releaseId)
    .first<{ mbid: string | null; spotify_id: string | null; art_key: string | null; group_mbid: string | null; group_spotify_id: string | null; standard_id: string }>();
  if (!row) return null;
  if (row.art_key && !replace) return null;

  // Each step stores a new version (artKeyFor); art_key is cleared so each step can set it.
  const clear = () => env.DB.prepare(`UPDATE release SET art_key = NULL WHERE id = ?`).bind(releaseId).run();

  if (row.mbid && row.group_mbid) {
    const had = row.art_key;
    if (had) await clear();
    const key = await storeCoverArt({ releaseId, releaseMbid: row.mbid, releaseGroupMbid: row.group_mbid, groupFallback: false });
    if (key) return 'cover art archive';
    if (had) await env.DB.prepare(`UPDATE release SET art_key = ? WHERE id = ?`).bind(had, releaseId).run();
  }

  // Apple's cover, at full size, for the album this edition belongs to.
  const names = await env.DB.prepare(
    `SELECT x.title, (SELECT a.name FROM artist_credit c JOIN artist a ON a.id = c.artist_id
                      WHERE c.entity_type = 'release_group' AND c.entity_id = x.release_group_id AND c.role = 'primary' ORDER BY c.position LIMIT 1) AS artist
     FROM release x WHERE x.id = ?`,
  )
    .bind(releaseId)
    .first<{ title: string; artist: string | null }>();
  if (names?.artist) {
    const template = await itunesCover(names.artist, names.title).catch(() => null);
    if (template && (await storeFromTemplate(releaseId, template))) return 'itunes';
  }

  // The album's Spotify link names its standard edition's Spotify album.
  const spotifyId = row.spotify_id ?? (row.standard_id === releaseId ? row.group_spotify_id : null);
  const owner = await ownerId();
  if (spotifyId && owner && (await connection(owner))) {
    const album = await fetchSpotifyAlbum(spotifyFor(owner), spotifyId);
    const had = (await env.DB.prepare(`SELECT art_key FROM release WHERE id = ?`).bind(releaseId).first<{ art_key: string | null }>())?.art_key;
    if (had) await clear();
    await storeSpotifyArt(releaseId, album);
    const now = await env.DB.prepare(`SELECT art_key FROM release WHERE id = ?`).bind(releaseId).first<{ art_key: string | null }>();
    if (now?.art_key) return 'spotify';
    if (had) await env.DB.prepare(`UPDATE release SET art_key = ? WHERE id = ?`).bind(had, releaseId).run();
  }

  if (!row.art_key && row.mbid && row.group_mbid) {
    const key = await storeCoverArt({ releaseId, releaseMbid: row.mbid, releaseGroupMbid: row.group_mbid });
    if (key) return 'cover art archive';
  }
  return null;
}
