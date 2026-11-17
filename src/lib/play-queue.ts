/**
 * What a Play button asks for (?album, ?track, ?playlist), as the songs to
 * play from your own files and where to start: for /play and for the
 * player that keeps going between pages (src/lib/client/local-player.ts).
 */
import { albumQueue, songQueue, songsQueue, type PlayableTrack } from './audio';
import { getDefinition } from './definitions';
import { selectIds } from './query/run';

export async function playQueue(params: URLSearchParams): Promise<{ queue: PlayableTrack[]; start: number }> {
  const albumId = params.get('album');
  const trackId = params.get('track');
  const playlistId = params.get('playlist');
  let queue: PlayableTrack[] = [];
  if (playlistId) {
    // A playlist of tracks: its songs you have audio for, in its order.
    const saved = await getDefinition(playlistId);
    if (saved && saved.definition.entity === 'recording') {
      queue = await songsQueue(await selectIds(saved.definition, { userId: saved.user_id, pins: saved.pins, excludes: saved.excludes }));
    }
  } else if (albumId) queue = await albumQueue(albumId);
  else if (trackId) queue = await songQueue(trackId);
  const start = Math.max(0, trackId ? queue.findIndex((t) => t.recordingId === trackId) : 0);
  return { queue, start };
}
