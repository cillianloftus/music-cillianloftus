/**
 * Finding an edition's cover again, best source first: its own scan on the
 * Cover Art Archive, then Apple Music, then its Spotify album, then Genius
 * (through its songs: releases made by hand often have no other), then
 * (only if it is no other edition's) the album-wide front. Also any image
 * by its address, for a cover found by hand.
 */

import { env } from 'cloudflare:workers';
import { ownerId } from './auth/user';
import { ART_SIZES, artKeyFor, storeCoverArt } from './import/coverart';
import { itunesCover } from './sources/itunes';
import { storeSpotifyArt } from './import/spotify';
import { fetchSpotifyAlbum } from './spotify/album';
import { connection, spotifyFor } from './spotify/client';
import { geniusAlbumCover, geniusToken } from './genius';

export type CoverSource = 'cover art archive' | 'itunes' | 'spotify' | 'genius' | null;

/** Where each source is named on the page. */
export const COVER_SOURCE_NAMES: Record<Exclude<CoverSource, null>, string> = {
  'cover art archive': 'the Cover Art Archive',
  itunes: 'Apple Music',
  spotify: 'Spotify',
  genius: 'Genius',
};

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export class CoverError extends Error {}

/**
 * Stores any image (PNG, JPEG, WebP) as an edition's cover: cropped square
 * from the centre and made into the stored JPEG widths, as an upload is in
 * the browser. Never enlarged past the image's own size.
 */
export async function storeCoverFromImage(releaseId: string, url: string): Promise<void> {
  let address: URL;
  try {
    address = new URL(url.trim());
  } catch {
    throw new CoverError('That is not a link. Paste the image’s address, starting https://');
  }
  if (address.protocol !== 'https:' && address.protocol !== 'http:') throw new CoverError('That is not a web link.');
  const res = await fetch(address, { headers: { accept: 'image/*' } }).catch(() => null);
  if (!res?.ok) throw new CoverError('That link did not answer with an image. Right-click the picture and copy the image’s address.');
  if (!(res.headers.get('content-type') ?? '').startsWith('image/')) throw new CoverError('That link is a page, not an image. Right-click the picture and copy the image’s address.');
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new CoverError('That image is over 15 MB.');
  const made = await Promise.all(
    ART_SIZES.map(async (size) => {
      const out = await env.IMAGES.input(new Response(bytes).body!)
        .transform({ width: size, height: size, fit: 'cover', gravity: 'center' })
        .output({ format: 'image/jpeg', quality: 88 });
      return new Response(out.image()).arrayBuffer();
    }),
  ).catch(() => {
    throw new CoverError('That file could not be read as an image.');
  });
  const key = artKeyFor(releaseId);
  await Promise.all(ART_SIZES.map((size, i) => env.ASSET_STORE.put(`${key}/${size}.jpg`, made[i]!, { httpMetadata: { contentType: 'image/jpeg' } })));
  await env.DB.prepare(`UPDATE release SET art_key = ? WHERE id = ?`).bind(key, releaseId).run();
}

/** Genius's cover for the album this edition belongs to, found through its songs. */
async function geniusCover(releaseId: string): Promise<string | null> {
  const token = await geniusToken();
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT g.title,
            (SELECT a.name FROM artist_credit c JOIN artist a ON a.id = c.artist_id
             WHERE c.entity_type = 'release_group' AND c.entity_id = g.id AND c.role = 'primary' ORDER BY c.position LIMIT 1) AS artist,
            (SELECT json_group_array(title) FROM (SELECT r.title FROM track t JOIN recording r ON r.id = t.recording_id
                                                 WHERE t.release_id = x.id ORDER BY t.disc, t.position LIMIT 3)) AS tracks
     FROM release x JOIN release_group g ON g.id = x.release_group_id WHERE x.id = ?`,
  )
    .bind(releaseId)
    .first<{ title: string; artist: string | null; tracks: string }>();
  if (!row?.artist) return null;
  return geniusAlbumCover(token, { artist: row.artist, title: row.title, tracks: JSON.parse(row.tracks) as string[] });
}

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

  const genius = await geniusCover(releaseId).catch((error) => (console.warn('Genius cover failed', releaseId, error), null));
  if (genius) {
    try {
      await storeCoverFromImage(releaseId, genius);
      return 'genius';
    } catch (error) {
      console.warn('Genius cover could not be stored', releaseId, error);
    }
  }

  if (!row.art_key && row.mbid && row.group_mbid) {
    const key = await storeCoverArt({ releaseId, releaseMbid: row.mbid, releaseGroupMbid: row.group_mbid });
    if (key) return 'cover art archive';
  }
  return null;
}
