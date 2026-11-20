/**
 * The albums of songs listened to but not in the library, imported. Each
 * listened track no recording matches (listen_track.recording_id null, with
 * a counted play) is looked up on Spotify: by its track id when the source
 * gave one, otherwise searched by title and artist. Its album is queued as
 * an ordinary Spotify import (which goes through MusicBrainz when it can),
 * all in one batch on the Jobs page. Once they land, the rematch after
 * imports points the plays at the new songs.
 *
 * The finding is itself a job (kind 'import_discography': albums found and
 * queued, here from listens rather than an artist), CHUNK songs a run, each
 * run queueing the next with what is left, so a few hundred songs never
 * outlast a Worker invocation or its request allowance.
 */

import { env } from 'cloudflare:workers';
import { createBatch, complete, enqueue, PRIORITY, type JobRow } from '../jobs/queue';
import { queueSpotifyAlbums } from './discography';
import { artistKey, titleKey } from '../listens/keys';
import { normaliseName } from '../text';
import { ownerId } from '../auth/user';
import { MARKET, spotifyFor, type SpotifyClient } from '../spotify/client';

/** Songs looked up a run: two Spotify requests each at most. */
export const CHUNK = 40;

export interface PlayedPayload {
  from: 'played';
  /** The listen_track keys still to look up, most played first. */
  keys: string[];
  /** Totals so far, carried from run to run. */
  looked: number;
  found: number;
  queued: number;
  result?: { looked: number; found: number; queued: number };
}

export interface SpotifyTrackFound {
  id: string;
  name: string;
  artists: { name: string }[];
  album: { id: string; name: string; album_type: string; release_date?: string; artists: { name: string }[] };
}

/**
 * The album to import for a listened track, from Spotify's candidates: the
 * same title (with or without "feat."), by the same artist, on a release of
 * that artist's own (never a various-artists compilation), an album before
 * a single, the earliest of those (the original, not a reissue).
 */
export function pickAlbum(want: { artist_key: string; title_key: string }, items: SpotifyTrackFound[]): SpotifyTrackFound['album'] | null {
  const byArtist = (names: { name: string }[]) => names.some((a) => normaliseName(a.name) === want.artist_key || artistKey(a.name) === want.artist_key);
  const fits = items.filter(
    (t) => t.album && t.album.album_type !== 'compilation' && titleKey(t.name) === want.title_key && byArtist(t.artists) && byArtist(t.album.artists ?? []),
  );
  const rank = (t: SpotifyTrackFound) => (t.album.album_type === 'album' ? 0 : 1);
  fits.sort((a, b) => rank(a) - rank(b) || (a.album.release_date ?? '9999').localeCompare(b.album.release_date ?? '9999'));
  return fits[0]?.album ?? null;
}

/** Search terms cannot carry quotes or field syntax. */
const term = (value: string) => value.replace(/["':]/g, ' ').replace(/\s+/g, ' ').trim();

interface Listened {
  key: string;
  artist: string;
  title: string;
  artist_key: string;
  title_key: string;
  spotify_id: string | null;
}

async function albumFor(spotify: SpotifyClient, track: Listened): Promise<SpotifyTrackFound['album'] | null> {
  if (track.spotify_id) {
    const exact = await spotify.get<SpotifyTrackFound>(`/tracks/${track.spotify_id}?market=${MARKET}`).catch(() => null);
    const album = exact ? pickAlbum(track, [exact]) : null;
    if (album) return album;
  }
  // The title without "feat. X": Spotify's search is stricter with it.
  const title = track.title.replace(/\s*[([](?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]|\s+(?:feat\.?|ft\.?|featuring)\s.+$/giu, '');
  const params = new URLSearchParams({ q: `track:${term(title)} artist:${term(track.artist)}`, type: 'track', limit: '10', market: MARKET });
  const found = await spotify.get<{ tracks: { items: SpotifyTrackFound[] } }>(`/search?${params}`);
  return pickAlbum(track, found.tracks.items);
}

/**
 * Every listened track not in the library with a counted play, most played
 * first. Reads the unmatched plays once (by play_recording's null range).
 */
export async function playedMissing(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT lt.key
     FROM (SELECT track_key, COUNT(*) AS n FROM play WHERE recording_id IS NULL AND counted = 1 GROUP BY track_key) p
     JOIN listen_track lt ON lt.key = p.track_key
     WHERE lt.recording_id IS NULL
     ORDER BY p.n DESC, lt.key`,
  ).all<{ key: string }>();
  return results.map((r) => r.key);
}

/** Starts the import: one batch, the finder first in it. Returns the batch and how many songs it will look up. */
export async function startPlayedImport(): Promise<{ batchId: string | null; songs: number }> {
  const keys = await playedMissing();
  if (keys.length === 0) return { batchId: null, songs: 0 };
  const batchId = await createBatch('Albums of songs you played', 'other', '/manage/history');
  const payload: PlayedPayload = { from: 'played', keys, looked: 0, found: 0, queued: 0 };
  await enqueue('import_discography', payload, PRIORITY.asked, batchId);
  return { batchId, songs: keys.length };
}

/** One run of the finder: CHUNK songs looked up, their albums queued, the rest queued as the next run. */
export async function findPlayedAlbums(job: JobRow): Promise<void> {
  const payload = JSON.parse(job.payload_json) as PlayedPayload;
  const owner = await ownerId();
  if (!owner) throw new Error('No owner account yet.');
  const spotify = spotifyFor(owner);
  const now = payload.keys.slice(0, CHUNK);
  const rest = payload.keys.slice(CHUNK);

  const { results } = await env.DB.prepare(
    `SELECT key, artist, title, artist_key, title_key, spotify_id FROM listen_track
     WHERE key IN (SELECT value FROM json_each(?)) AND recording_id IS NULL`,
  )
    .bind(JSON.stringify(now))
    .all<Listened>();
  const order = new Map(now.map((k, i) => [k, i]));
  results.sort((a, b) => order.get(a.key)! - order.get(b.key)!);

  const albums: { id: string; name: string }[] = [];
  for (const track of results) {
    const album = await albumFor(spotify, track);
    if (album) albums.push({ id: album.id, name: album.name });
  }
  const { queued } = await queueSpotifyAlbums(albums, PRIORITY.bulk, job.batch_id);
  const totals = { looked: payload.looked + results.length, found: payload.found + albums.length, queued: payload.queued + queued.length };
  if (rest.length) await enqueue('import_discography', { from: 'played', keys: rest, ...totals } satisfies PlayedPayload, PRIORITY.asked, job.batch_id);
  // Done: the keys it looked up are not worth keeping.
  await complete(job.id, { from: 'played', keys: [], ...totals, result: totals }, results.length);
}
