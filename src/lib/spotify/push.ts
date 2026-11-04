/**
 * Pushes a saved definition to Spotify (build step 5).
 *
 * The selection comes from the same compile() as the playlist page, so the
 * Spotify playlist holds exactly what the preview showed, minus anything
 * Spotify cannot supply, which is reported rather than silently dropped:
 *   - unmatched: no confident Spotify track for the recording
 *   - unplayable: on Spotify, but not playable in the account's market
 *
 * The playlist is updated in place on every push (never "Top 100 (2)"),
 * and each push is snapshotted in definition_run.
 */

import { env } from 'cloudflare:workers';
import { getDefinition } from '../definitions';
import { selectIds } from '../query/run';
import { MARKET, SpotifyError, spotifyFor, type SpotifyClient } from './client';
import { resolveSpotifyIds } from './match';

export interface PushReport {
  playlistId: string;
  playlistUrl: string;
  selected: number;
  pushed: number;
  unmatched: { id: string; title: string; artist: string | null }[];
  unplayable: { spotifyId: string; title: string }[];
  /** Whether the generated cover went up: covers never fail a push. */
  cover?: 'uploaded' | 'failed' | 'none';
}

/** Uploads the stored cover, if there is one. Returns what happened rather than throwing. */
async function uploadCover(spotify: SpotifyClient, playlistId: string, artKey: string | null): Promise<PushReport['cover']> {
  if (!artKey) return 'none';
  try {
    const object = await env.ASSET_STORE.get(artKey);
    if (!object) return 'none';
    const bytes = new Uint8Array(await object.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    await spotify.putJpeg(`/playlists/${playlistId}/images`, btoa(binary));
    return 'uploaded';
  } catch (error) {
    console.warn('Playlist cover upload failed', error);
    return 'failed';
  }
}

/** Spotify takes up to 256 KB of base64, so about 190 KB of JPEG. Checked by its magic bytes, not its name. */
export function isSmallJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 100 && bytes.length <= 190_000 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

const MAX_ITEMS_PER_REQUEST = 100;
const MAX_DESCRIPTION = 300;

interface Playlist {
  id: string;
  external_urls: { spotify: string };
}

interface PlaylistItemsPage {
  items: { item: { id: string; name: string; is_playable?: boolean } | null }[];
  next: string | null;
}

function descriptionFor(description: string | null): string {
  const base = description ? `${description} · ` : '';
  // Spotify rejects newlines in descriptions.
  return `${base}Generated from a saved query at music.cillianloftus.com`.replace(/\s+/g, ' ').slice(0, MAX_DESCRIPTION);
}

/** Updates the existing playlist, or creates one if there is none (or it was deleted on Spotify). */
async function ensurePlaylist(
  spotify: SpotifyClient,
  existingId: string | null,
  details: { name: string; description: string },
): Promise<Playlist> {
  if (existingId) {
    try {
      await spotify.put(`/playlists/${existingId}`, details);
      return { id: existingId, external_urls: { spotify: `https://open.spotify.com/playlist/${existingId}` } };
    } catch (error) {
      if (!(error instanceof SpotifyError) || error.status !== 404) throw error;
    }
  }
  return spotify.post<Playlist>('/me/playlists', { ...details, public: false });
}

async function replaceItems(spotify: SpotifyClient, playlistId: string, uris: string[]): Promise<void> {
  // PUT replaces the whole playlist with its first 100; the rest are appended.
  await spotify.put(`/playlists/${playlistId}/items`, { uris: uris.slice(0, MAX_ITEMS_PER_REQUEST) });
  for (let i = MAX_ITEMS_PER_REQUEST; i < uris.length; i += MAX_ITEMS_PER_REQUEST) {
    await spotify.post(`/playlists/${playlistId}/items`, { uris: uris.slice(i, i + MAX_ITEMS_PER_REQUEST) });
  }
}

/** Tracks Spotify will not play in the account's market (ARCHITECTURE.md §6). */
async function findUnplayable(spotify: SpotifyClient, playlistId: string): Promise<PushReport['unplayable']> {
  const unplayable: PushReport['unplayable'] = [];
  let path: string | null = `/playlists/${playlistId}/items?market=${MARKET}&limit=50&fields=${encodeURIComponent('items(item(id,name,is_playable)),next')}`;
  while (path) {
    const page: PlaylistItemsPage = await spotify.get<PlaylistItemsPage>(path);
    for (const entry of page.items) {
      if (entry.item && entry.item.is_playable === false) {
        unplayable.push({ spotifyId: entry.item.id, title: entry.item.name });
      }
    }
    path = page.next ? page.next.replace('https://api.spotify.com/v1', '') : null;
  }
  return unplayable;
}

export async function pushDefinition(definitionId: string): Promise<PushReport> {
  const saved = await getDefinition(definitionId);
  if (!saved) throw new Error('That playlist no longer exists.');
  if (saved.definition.entity !== 'recording') {
    throw new Error('Only track playlists can be pushed to Spotify. Set "entity": "recording".');
  }

  const spotify = spotifyFor(saved.user_id);
  const ids = await selectIds(saved.definition, {
    userId: saved.user_id,
    pins: saved.pins,
    excludes: saved.excludes,
  });
  const { matched, unmatched } = await resolveSpotifyIds(spotify, ids);

  // In compile() order, without duplicates (two recordings can share a master).
  const uris = [...new Set(ids.flatMap((id) => (matched.has(id) ? [`spotify:track:${matched.get(id)}`] : [])))];

  const playlist = await ensurePlaylist(spotify, saved.spotify_playlist_id, {
    name: saved.name,
    description: descriptionFor(saved.description),
  });
  if (playlist.id !== saved.spotify_playlist_id) {
    await env.DB.prepare('UPDATE definition SET spotify_playlist_id = ? WHERE id = ?')
      .bind(playlist.id, saved.id)
      .run();
  }

  await replaceItems(spotify, playlist.id, uris);
  await env.DB.prepare('INSERT INTO definition_run (id, definition_id, result_ids_json) VALUES (?, ?, ?)')
    .bind(crypto.randomUUID(), saved.id, JSON.stringify(ids))
    .run();

  const unplayable = uris.length > 0 ? await findUnplayable(spotify, playlist.id) : [];
  const cover = await uploadCover(spotify, playlist.id, saved.art_key);

  return {
    playlistId: playlist.id,
    playlistUrl: playlist.external_urls.spotify,
    selected: ids.length,
    pushed: uris.length,
    unmatched,
    unplayable,
    cover,
  };
}
