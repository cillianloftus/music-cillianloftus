/**
 * What a Play button asks for (?album, ?track, ?playlist), as the songs to
 * play and where to start: for /play and for the player that keeps going
 * between pages (src/lib/client/local-player.ts).
 *
 * Each song plays from your own file when you have uploaded it; with
 * Spotify connected, the rest come from Spotify (17 Nov: one queue for
 * both, so an album half uploaded plays whole, and a playlist mixes them).
 * A song with both plays as the setting says (playPrefer): on Spotify by
 * default, so it counts in Spotify's own history (Wrapped), the file
 * taking over whenever Spotify cannot play (the player decides, song by song).
 */
import { env } from 'cloudflare:workers';
import { albumQueue, songQueue, songsQueue, type PlayableTrack, type QueueSources } from './audio';
import { getDefinition } from './definitions';
import { selectIds } from './query/run';
import { connection } from './spotify/client';

/** Spotify may fill a queue's gaps when the listener has it connected. */
export async function queueSources(userId: string): Promise<QueueSources> {
  return { spotify: Boolean(await connection(userId)) };
}

/** A song both uploaded and on Spotify: which plays it. */
export type PlayPrefer = 'spotify' | 'file';
const PREFER_KEY = 'play_prefer';

export async function playPrefer(): Promise<PlayPrefer> {
  const row = await env.DB.prepare('SELECT value FROM app_setting WHERE key = ?').bind(PREFER_KEY).first<{ value: string }>();
  return row?.value === 'file' ? 'file' : 'spotify';
}

export async function setPlayPrefer(value: PlayPrefer): Promise<void> {
  await env.DB.prepare('INSERT INTO app_setting (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .bind(PREFER_KEY, value)
    .run();
}

export async function playQueue(params: URLSearchParams, sources: QueueSources = {}): Promise<{ queue: PlayableTrack[]; start: number }> {
  const albumId = params.get('album');
  const trackId = params.get('track');
  const playlistId = params.get('playlist');
  let queue: PlayableTrack[] = [];
  if (playlistId) {
    // A playlist of tracks, in its order.
    const saved = await getDefinition(playlistId);
    if (saved && saved.definition.entity === 'recording') {
      queue = await songsQueue(await selectIds(saved.definition, { userId: saved.user_id, pins: saved.pins, excludes: saved.excludes }), sources);
    }
  } else if (albumId) queue = await albumQueue(albumId, sources);
  else if (trackId) {
    // One song played from its album: the album, from that song on, so the music goes on
    // when it ends (17 Nov). The song alone if its album has nothing else to play.
    const home = await env.DB.prepare(`SELECT release_group_id AS id FROM v_recording_album WHERE recording_id = ? LIMIT 1`)
      .bind(trackId)
      .first<{ id: string }>();
    queue = home ? await albumQueue(home.id, sources) : [];
    if (!queue.some((t) => t.recordingId === trackId)) queue = await songQueue(trackId, sources);
  }
  const start = Math.max(0, trackId ? queue.findIndex((t) => t.recordingId === trackId) : 0);
  return { queue, start };
}
