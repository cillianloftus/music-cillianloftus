/**
 * Importing an album from a Spotify link (ARCHITECTURE.md §5, rung 2).
 *
 *   1. Fetch the album by id (and its ISRCs).
 *   2. Look its barcode up on MusicBrainz. A confident hit is imported from
 *      there instead, since MusicBrainz has the richer record (works,
 *      credits, genres); the Spotify ids are then filled in on it.
 *   3. Otherwise build the plan from Spotify. An album already in the
 *      catalogue with the same title by the same artist gains this as an
 *      edition rather than being duplicated.
 *
 * Either way the album ends up holding its Spotify ids, so playlist pushes
 * need no searching for it.
 */

import { env } from 'cloudflare:workers';
import { ownerId } from '../auth/user';
import { MusicBrainzError, releasesByBarcode } from '../musicbrainz/client';
import { fetchSpotifyAlbum, planFromSpotify, type SpotifyAlbum, type SpotifyTarget } from '../spotify/album';
import { spotifyFor, type SpotifyClient } from '../spotify/client';
import { normaliseName, normaliseTitle } from '../text';
import { artKeyFor, ART_SIZES, storeCoverArt } from './coverart';
import { planFromMusicBrainz } from './musicbrainz';
import type { ImportPlan } from './plan';
import { writePlan, type WriteResult } from './write';

/** MusicBrainz search scores run to 100; below this a barcode hit is not trusted. */
const BARCODE_SCORE = 90;

export interface SpotifyImportResult extends WriteResult {
  via: 'musicbrainz' | 'spotify';
}

/** The release MBID for a barcode, when MusicBrainz knows it unambiguously. */
async function musicBrainzReleaseFor(album: SpotifyAlbum): Promise<string | null> {
  const barcode = album.external_ids?.upc ?? album.external_ids?.ean;
  if (!barcode) return null;
  try {
    const hits = (await releasesByBarcode(barcode)).filter((h) => h.score >= BARCODE_SCORE);
    return hits.length === 1 ? hits[0]!.id : null;
  } catch (error) {
    // MusicBrainz being down is no reason to fail: Spotify's data will do.
    if (error instanceof MusicBrainzError) return null;
    throw error;
  }
}

/** An album already here with this title by this artist, if exactly one. */
async function existingAlbum(album: SpotifyAlbum): Promise<string | null> {
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.title, a.name
     FROM release_group g
     JOIN artist_credit c ON c.entity_type = 'release_group' AND c.entity_id = g.id AND c.role = 'primary' AND c.position = 1
     JOIN artist a ON a.id = c.artist_id
     WHERE lower(a.name) = lower(?)`,
  )
    .bind(album.artists[0]?.name ?? '')
    .all<{ id: string; title: string; name: string }>();
  const title = normaliseTitle(album.name);
  const artist = normaliseName(album.artists[0]?.name ?? '');
  const matches = results.filter((r) => normaliseTitle(r.title) === title && normaliseName(r.name) === artist);
  return matches.length === 1 ? matches[0]!.id : null;
}

/**
 * After a MusicBrainz import: the album and edition take the Spotify
 * album's id, and each track its Spotify track's, matched by disc and
 * position. Only empty ids are filled, and never one held elsewhere.
 */
async function fillSpotifyIds(result: WriteResult, album: SpotifyAlbum): Promise<void> {
  const db = env.DB;
  const free = (table: string) => `NOT EXISTS (SELECT 1 FROM ${table} o WHERE o.spotify_id = ?1)`;
  await db.batch([
    db.prepare(`UPDATE release_group SET spotify_id = ?1 WHERE id = ?2 AND spotify_id IS NULL AND ${free('release_group')}`).bind(album.id, result.releaseGroupId),
    db.prepare(`UPDATE release SET spotify_id = ?1 WHERE id = ?2 AND spotify_id IS NULL AND ${free('release')}`).bind(album.id, result.releaseId),
    // One keyed update per track: an UPDATE … FROM json_each walked the
    // whole recording table for each one.
    ...album.tracks.items.map((t) =>
      db.prepare(
        `UPDATE recording SET spotify_id = ?1
         WHERE id = (SELECT recording_id FROM track WHERE release_id = ?2 AND disc = ?3 AND position = ?4)
           AND spotify_id IS NULL AND ${free('recording')}`,
      ).bind(t.id, result.releaseId, t.disc_number || 1, t.track_number),
    ),
  ]);
}

/**
 * Before a MusicBrainz import: the plan carries the Spotify album's ids,
 * so an album first built from Spotify alone (MusicBrainz had nothing
 * then) is found by them and filled in, its ratings kept, rather than
 * imported a second time beside itself. A track's id goes only where
 * disc, position and title all agree.
 */
export function adoptSpotifyIds(plan: ImportPlan, album: SpotifyAlbum): void {
  plan.releaseGroup.spotify_id ??= album.id;
  plan.release.spotify_id ??= album.id;
  for (const t of plan.tracks) {
    const theirs = album.tracks.items.find((i) => (i.disc_number || 1) === t.disc && i.track_number === t.position);
    const recording = plan.recordings.find((r) => r.key === t.recording_key);
    if (theirs && recording && !recording.spotify_id && normaliseTitle(theirs.name) === normaliseTitle(recording.title)) {
      recording.spotify_id = theirs.id;
    }
  }
}

/**
 * Spotify's cover, stored under the same keys as Cover Art Archive art:
 * its 300 px image as the small size, its 640 px image for the larger two.
 */
export async function storeSpotifyArt(releaseId: string, album: SpotifyAlbum): Promise<void> {
  const existing = await env.DB.prepare(`SELECT art_key FROM release WHERE id = ?`).bind(releaseId).first<string>('art_key');
  if (existing || album.images.length === 0) return;
  const bySize = [...album.images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  const large = bySize[0]!;
  const small = bySize.find((i) => (i.width ?? 0) >= 250 && (i.width ?? 0) < (large.width ?? 0)) ?? large;
  const fetchImage = async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Spotify art returned ${response.status}`);
    return response.arrayBuffer();
  };
  const [smallBody, largeBody] = await Promise.all([fetchImage(small.url), small === large ? null : fetchImage(large.url)]);
  const key = artKeyFor(releaseId);
  await Promise.all(
    ART_SIZES.map((size) =>
      env.ASSET_STORE.put(`${key}/${size}.jpg`, size === ART_SIZES[0] ? smallBody : (largeBody ?? smallBody), {
        httpMetadata: { contentType: 'image/jpeg' },
      }),
    ),
  );
  await env.DB.prepare(`UPDATE release SET art_key = ? WHERE id = ? AND art_key IS NULL`).bind(key, releaseId).run();
}

export async function importFromSpotify(target: SpotifyTarget, client?: SpotifyClient): Promise<SpotifyImportResult> {
  let spotify = client;
  if (!spotify) {
    const owner = await ownerId();
    if (!owner) throw new Error('No owner account yet.');
    spotify = spotifyFor(owner);
  }

  let albumId = target.id;
  if (target.kind === 'track') {
    albumId = (await spotify.get<{ album: { id: string } }>(`/tracks/${target.id}`)).album.id;
  }
  const album = await fetchSpotifyAlbum(spotify, albumId);

  let result: WriteResult;
  let via: SpotifyImportResult['via'];
  const mbid = await musicBrainzReleaseFor(album);
  if (mbid) {
    const plan = await planFromMusicBrainz({ entity: 'release', mbid });
    adoptSpotifyIds(plan, album);
    result = await writePlan(plan);
    await fillSpotifyIds(result, album);
    via = 'musicbrainz';
    // The Cover Art Archive's scans first; Spotify's cover below if it has none.
    if (plan.release.mbid && plan.releaseGroup.mbid) {
      await storeCoverArt({ releaseId: result.releaseId, releaseMbid: plan.release.mbid, releaseGroupMbid: plan.releaseGroup.mbid }).catch(() => null);
    }
  } else {
    const into = await existingAlbum(album);
    result = await writePlan(planFromSpotify(album), into ? { intoReleaseGroup: into } : {});
    via = 'spotify';
  }

  try {
    await storeSpotifyArt(result.releaseId, album);
  } catch (error) {
    console.warn('Spotify art failed', error); // The review queue reports albums without art.
  }
  return { ...result, via };
}
