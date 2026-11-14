/**
 * The library's recording for a song Spotify is playing (Now playing, the
 * rating nudge). Only about a third of the library has a Spotify track id,
 * so that alone said "not in the library" of songs that are (Chaos Space
 * Marine, on 14 Nov). In order, cheapest first:
 *
 * 1. the Spotify track id;
 * 2. a listen already matched to a recording under that id;
 * 3. the ISRC, where Spotify gives one;
 * 4. the title (as given, then without "- Remastered" and the like), by
 *    one of the song's artists, by Spotify id or by name: a seek on the
 *    title index, then a look at each candidate's credits. Several (an
 *    album version and a live one): the one on an album of that name first.
 *
 * Found by 3 or 4, the recording is given the Spotify id if it has none and
 * no other recording has it, so the next time is step 1. Imports fill nulls;
 * this is the same.
 */

import { env } from 'cloudflare:workers';
import { stripEditionSuffixes } from './text';

export interface PlayingSong {
  spotifyId: string;
  isrc?: string | null;
  title: string;
  /** The song's artists' names, as Spotify gives them. */
  artists: string[];
  /** Their Spotify ids, where known. */
  artistIds?: string[];
  album?: string | null;
}

/** "Song - Remastered 2011" → "Song"; Spotify's way of naming a version. */
function titlesToTry(title: string): string[] {
  const dashless = title.replace(/\s+-\s+.*$/, '');
  return [...new Set([title, stripEditionSuffixes(title), dashless, stripEditionSuffixes(dashless)].map((t) => t.trim()).filter(Boolean))];
}

export async function findRecording(song: PlayingSong): Promise<string | null> {
  const direct = await env.DB.prepare(
    `SELECT coalesce(
       (SELECT id FROM recording WHERE spotify_id = ?1),
       (SELECT recording_id FROM listen_track WHERE key = 'spotify:' || ?1),
       (SELECT id FROM recording WHERE ?2 IS NOT NULL AND isrc = ?2 LIMIT 1)
     ) AS id,
     (SELECT 1 FROM recording WHERE spotify_id = ?1) AS has_id`,
  )
    .bind(song.spotifyId, song.isrc?.toUpperCase() ?? null)
    .first<{ id: string | null; has_id: number | null }>();
  if (direct?.id) {
    if (!direct.has_id) await remember(direct.id, song.spotifyId);
    return direct.id;
  }

  const titles = titlesToTry(song.title);
  const names = song.artists.filter(Boolean);
  if (titles.length === 0 || names.length === 0) return null;
  const row = await env.DB.prepare(
    `SELECT r.id FROM recording r
     WHERE r.title COLLATE NOCASE IN (SELECT value FROM json_each(?1))
       AND EXISTS (SELECT 1 FROM artist_credit c JOIN artist a ON a.id = c.artist_id
                   WHERE c.entity_type = 'recording' AND c.entity_id = r.id AND c.role = 'primary'
                     AND (a.spotify_id IN (SELECT value FROM json_each(?2))
                          OR a.name COLLATE NOCASE IN (SELECT value FROM json_each(?3))))
     ORDER BY EXISTS (SELECT 1 FROM track t JOIN release x ON x.id = t.release_id JOIN release_group g ON g.id = x.release_group_id
                      WHERE t.recording_id = r.id AND g.title = ?4 COLLATE NOCASE) DESC,
              r.spotify_id IS NULL DESC
     LIMIT 1`,
  )
    .bind(JSON.stringify(titles), JSON.stringify(song.artistIds ?? []), JSON.stringify(names), song.album ?? null)
    .first<{ id: string }>();
  if (!row) return null;
  await remember(row.id, song.spotifyId);
  return row.id;
}

/** The Spotify id, on a recording without one, when no other recording holds it. */
async function remember(recordingId: string, spotifyId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE recording SET spotify_id = ?2
     WHERE id = ?1 AND spotify_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM recording WHERE spotify_id = ?2)
       AND NOT EXISTS (SELECT 1 FROM field_override WHERE entity_type = 'recording' AND entity_id = ?1 AND field = 'spotify_id')`,
  )
    .bind(recordingId, spotifyId)
    .run()
    .catch((error) => console.warn('Remembering the Spotify id failed', error));
}
