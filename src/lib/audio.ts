/**
 * Your own audio, uploaded and played back (migration 0079). Files on
 * Cillian's machine are matched to songs already in the library, uploaded
 * to a private bucket (AUDIO_STORE) and played on /play, anywhere he is
 * signed in. Served only to the owner (src/pages/audio/[id].ts); nothing
 * is public, and nothing is fetched from a streaming service.
 *
 * Matching, in order: a file already catalogued (by checksum, then path);
 * the recording MusicBrainz names in its tags; else a song by the tagged
 * artist with the same title (case, punctuation and guests aside), the one
 * on the tagged album first, then the closest in length.
 */

import { env } from 'cloudflare:workers';
import { listenTrack } from './listens/keys';
import { savePlays } from './listens/store';
import { normaliseName, normaliseTitle, withoutCredits } from './text';

/** What the browser reads from each file and sends to be matched. */
export interface FileToMatch {
  path: string;
  checksum: string | null;
  format: string;
  title: string | null;
  artist: string | null;
  albumArtist: string | null;
  album: string | null;
  lengthMs: number | null;
  mbRecordingId: string | null;
}

export interface FileMatch {
  path: string;
  recordingId: string | null;
  /** The song it was matched to, as the library has it. */
  title: string | null;
  album: string | null;
  /** Its audio is already uploaded (the same file, by checksum): nothing to send. */
  uploaded: boolean;
  /** Its loudness is known (0082): uploaded before that, it is measured and sent on its own. */
  measured: boolean;
}

export const AUDIO_FORMATS = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
} as const;
export type AudioFormat = keyof typeof AUDIO_FORMATS;

export { MAX_AUDIO_BYTES } from './audio-limits';

const songKey = (title: string) => normaliseTitle(withoutCredits(title));

/**
 * What a file's path says, for files with no tags: "Artist/Album/04 - Title.flac"
 * (the track number and an "Artist - " prefix on the name aside).
 */
export function fromPath(path: string): { title: string | null; artist: string | null; album: string | null } {
  const parts = path.split(/[\\/]/).filter(Boolean);
  let name = (parts.at(-1) ?? '').replace(/\.[a-z0-9]{2,4}$/i, '');
  name = name.replace(/^\s*(?:\d{1,2}[-.]\s*)?\d{1,3}(?:\s*[-.–_)]\s*|\s+)/, '').trim();
  let artist = parts.length >= 3 ? parts.at(-3)! : null;
  const split = /^(.+?)\s+[-–]\s+(.+)$/.exec(name);
  if (split) {
    artist ??= split[1]!.trim();
    name = split[2]!.trim();
  }
  return { title: name || null, artist, album: parts.length >= 2 ? parts.at(-2)! : null };
}

/** Within this of the library's length, an untagged file with the same title is taken to be that song. */
const TITLE_ONLY_GAP_MS = 3_000;

export async function matchFiles(input: FileToMatch[]): Promise<FileMatch[]> {
  if (input.length === 0) return [];
  // Untagged files go by their path.
  const files = input.map((f) => {
    if (f.title && f.artist) return f;
    const guess = fromPath(f.path);
    return { ...f, title: f.title ?? guess.title, artist: f.artist ?? f.albumArtist ?? guess.artist, album: f.album ?? guess.album };
  });
  // Already catalogued: by checksum, then by path.
  const { results: known } = await env.DB.prepare(
    `SELECT f.path, f.checksum, f.recording_id, f.audio_key IS NOT NULL AS uploaded, f.loudness_lufs IS NOT NULL AS measured FROM file f
     WHERE f.checksum IN (SELECT value ->> '$.checksum' FROM json_each(?1)) OR f.path IN (SELECT value ->> '$.path' FROM json_each(?1))`,
  )
    .bind(JSON.stringify(files.map((f) => ({ path: f.path, checksum: f.checksum }))))
    .all<{ path: string; checksum: string | null; recording_id: string; uploaded: number; measured: number }>();
  const byChecksum = new Map(known.filter((k) => k.checksum).map((k) => [k.checksum!, k]));
  const byPath = new Map(known.map((k) => [k.path, k]));

  // By MusicBrainz recording id.
  const mbids = [...new Set(files.map((f) => f.mbRecordingId).filter((m): m is string => Boolean(m)))];
  const { results: byMbid } = mbids.length
    ? await env.DB.prepare(`SELECT id, mbid FROM recording WHERE mbid IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(mbids)).all<{ id: string; mbid: string }>()
    : { results: [] as { id: string; mbid: string }[] };
  const mbidRecording = new Map(byMbid.map((r) => [r.mbid, r.id]));

  // Every song by each tagged artist (and album artist), with the albums it is on and its length.
  const artists = [...new Set(files.flatMap((f) => [f.artist, f.albumArtist]).filter((a): a is string => Boolean(a)).map((a) => a.split(/\s*(?:,|&|feat\.?|ft\.?)\s*/i)[0]!.trim()))];
  const { results: songs } = artists.length
    ? await env.DB.prepare(
        `WITH who AS (
           SELECT id, name FROM artist WHERE name COLLATE NOCASE IN (SELECT value FROM json_each(?1))
           UNION SELECT a.artist_id, x.value FROM artist_alias a JOIN json_each(?1) x ON a.name = x.value
         )
         SELECT DISTINCT r.id, r.title, r.length_ms, who.name AS artist,
                (SELECT group_concat(g.title, '|') FROM track t JOIN release x ON x.id = t.release_id
                 JOIN release_group g ON g.id = x.release_group_id WHERE t.recording_id = r.id) AS albums
         FROM who JOIN artist_credit c ON c.artist_id = who.id AND c.entity_type = 'recording' AND c.role = 'primary'
         JOIN recording r ON r.id = c.entity_id`,
      )
        .bind(JSON.stringify(artists))
        .all<{ id: string; title: string; length_ms: number | null; artist: string; albums: string | null }>()
    : { results: [] as { id: string; title: string; length_ms: number | null; artist: string; albums: string | null }[] };

  // Last, for files with no artist to go on (or a folder name that is not
  // one): any song of that exact title, if just one is about the same length.
  const titles = [...new Set(files.filter((f) => f.title && f.lengthMs).map((f) => f.title!))];
  const { results: sameTitle } = titles.length
    ? await env.DB.prepare(
        `SELECT r.id, r.title, r.length_ms,
                (SELECT group_concat(g.title, '|') FROM track t JOIN release x ON x.id = t.release_id
                 JOIN release_group g ON g.id = x.release_group_id WHERE t.recording_id = r.id) AS albums
         FROM recording r WHERE r.title COLLATE NOCASE IN (SELECT value FROM json_each(?)) AND r.length_ms IS NOT NULL`,
      )
        .bind(JSON.stringify(titles))
        .all<{ id: string; title: string; length_ms: number; albums: string | null }>()
    : { results: [] as { id: string; title: string; length_ms: number; albums: string | null }[] };
  const byTitleAndLength = (file: FileToMatch): string | null => {
    if (!file.title || !file.lengthMs) return null;
    const close = sameTitle.filter((s) => s.title.toLowerCase() === file.title!.toLowerCase() && Math.abs(s.length_ms - file.lengthMs!) <= TITLE_ONLY_GAP_MS);
    if (close.length === 1) return close[0]!.id;
    // Several: the one on the album the folder names, if exactly one is.
    const album = file.album ? normaliseTitle(file.album) : null;
    const onAlbum = album ? close.filter((s) => (s.albums ?? '').split('|').some((a) => normaliseTitle(a) === album)) : [];
    return onAlbum.length === 1 ? onAlbum[0]!.id : null;
  };

  const matched = files.map((file): { file: FileToMatch; recordingId: string | null; uploaded: boolean; measured?: boolean } => {
    const same = (file.checksum && byChecksum.get(file.checksum)) || byPath.get(file.path);
    if (same) return { file, recordingId: same.recording_id, uploaded: same.uploaded === 1 && same.checksum === file.checksum, measured: same.measured === 1 };
    const viaMbid = file.mbRecordingId ? mbidRecording.get(file.mbRecordingId) : undefined;
    if (viaMbid) return { file, recordingId: viaMbid, uploaded: false };
    if (!file.title) return { file, recordingId: null, uploaded: false };
    const key = songKey(file.title);
    const names = new Set([file.artist, file.albumArtist].filter((a): a is string => Boolean(a)).map((a) => normaliseName(a.split(/\s*(?:,|&|feat\.?|ft\.?)\s*/i)[0]!.trim())));
    const album = file.album ? normaliseTitle(file.album) : null;
    const candidates = songs.filter((s) => names.has(normaliseName(s.artist)) && songKey(s.title) === key);
    const onAlbum = (s: (typeof songs)[number]) => (album && (s.albums ?? '').split('|').some((a) => normaliseTitle(a) === album) ? 1 : 0);
    // An unknown length says nothing either way.
    const gap = (s: (typeof songs)[number]) => (file.lengthMs && s.length_ms ? Math.abs(file.lengthMs - s.length_ms) : 0);
    const best = candidates.sort((a, b) => onAlbum(b) - onAlbum(a) || gap(a) - gap(b))[0];
    // A song far longer or shorter is another version (a live take, an edit): not this one.
    return { file, recordingId: best && gap(best) <= 15_000 ? best.id : byTitleAndLength(file), uploaded: false };
  });

  const ids = [...new Set(matched.map((m) => m.recordingId).filter((id): id is string => Boolean(id)))];
  const { results: named } = ids.length
    ? await env.DB.prepare(
        `SELECT r.id, r.title, (SELECT g.title FROM v_recording_album ra JOIN release_group g ON g.id = ra.release_group_id WHERE ra.recording_id = r.id) AS album
         FROM recording r WHERE r.id IN (SELECT value FROM json_each(?))`,
      )
        .bind(JSON.stringify(ids))
        .all<{ id: string; title: string; album: string | null }>()
    : { results: [] as { id: string; title: string; album: string | null }[] };
  const names = new Map(named.map((n) => [n.id, n]));
  return matched.map((m) => ({
    path: m.file.path,
    recordingId: m.recordingId,
    title: m.recordingId ? (names.get(m.recordingId)?.title ?? null) : null,
    album: m.recordingId ? (names.get(m.recordingId)?.album ?? null) : null,
    uploaded: m.uploaded,
    measured: m.measured ?? false,
  }));
}

/**
 * Keeps one uploaded file's audio: catalogued at its path against the song
 * (a path already catalogued takes the new song and checksum), the bytes
 * streamed to the private bucket. Returns the file's id.
 */
export async function storeAudio(input: {
  recordingId: string;
  path: string;
  format: AudioFormat;
  checksum: string | null;
  size: number;
  body: ReadableStream;
}): Promise<string> {
  const row = await env.DB.prepare(
    `INSERT INTO file (id, recording_id, path, format, checksum) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (path) DO UPDATE SET recording_id = excluded.recording_id, format = excluded.format, checksum = excluded.checksum
     RETURNING id`,
  )
    .bind(crypto.randomUUID(), input.recordingId, input.path, input.format, input.checksum)
    .first<{ id: string }>();
  const id = row!.id;
  const key = `audio/${id}.${input.format}`;
  // A stream of known length goes straight through, never held in memory (R2 needs the
  // length up front; FixedLengthStream is the Workers runtime's, so tests send the stream as it is).
  if (typeof FixedLengthStream === 'undefined') {
    await env.AUDIO_STORE.put(key, input.body, { httpMetadata: { contentType: AUDIO_FORMATS[input.format] } });
  } else {
    const sized = new FixedLengthStream(input.size);
    const piping = input.body.pipeTo(sized.writable);
    await env.AUDIO_STORE.put(key, sized.readable, { httpMetadata: { contentType: AUDIO_FORMATS[input.format] } });
    await piping;
  }
  await env.DB.prepare(`UPDATE file SET audio_key = ?1, audio_bytes = ?2, uploaded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?3`)
    .bind(key, input.size, id)
    .run();
  return id;
}

export interface PlayableTrack {
  /** Your uploaded file, which plays in the browser; or, with none, */
  fileId: string | null;
  /** the song on Spotify, which Spotify plays (a mixed queue, local-player.ts). */
  spotifyId: string | null;
  recordingId: string;
  title: string;
  artist: string;
  album: string | null;
  albumId: string | null;
  artKey: string | null;
  lengthMs: number | null;
  /** Your file's measured loudness (LUFS, 0082): the player plays it at Spotify's level. */
  loudness: number | null;
}

const PLAYABLE = `
  SELECT f.id AS fileId, r.id AS recordingId, coalesce(t.title_on_release, r.title) AS title,
         (SELECT group_concat(a.name, ', ') FROM artist_credit c JOIN artist a ON a.id = c.artist_id
          WHERE c.entity_type = 'recording' AND c.entity_id = r.id AND c.role = 'primary') AS artist,
         g.title AS album, g.id AS albumId, coalesce(x.art_key, (SELECT y.art_key FROM release y WHERE y.release_group_id = g.id AND y.art_key IS NOT NULL LIMIT 1)) AS artKey,
         r.length_ms AS lengthMs, r.spotify_id AS spotifyId, f.loudness_lufs AS loudness`;

/** Where a queue may take songs from: your files only, or Spotify too for the rest. */
export interface QueueSources {
  spotify?: boolean;
}

/** Your latest upload of the song, required unless Spotify may play what has none. */
const fileJoin = (spotify: boolean) =>
  `${spotify ? 'LEFT ' : ''}JOIN file f ON f.id = (SELECT id FROM file WHERE recording_id = r.id AND audio_key IS NOT NULL ORDER BY uploaded_at DESC LIMIT 1)`;
const playableRow = (spotify: boolean) => (spotify ? 'AND (f.id IS NOT NULL OR r.spotify_id IS NOT NULL)' : '');

/**
 * An album's songs you have audio for, in order (its standard edition's,
 * then any others' bonus songs), for the player's queue.
 */
export async function albumQueue(albumId: string, { spotify = false }: QueueSources = {}): Promise<PlayableTrack[]> {
  const { results } = await env.DB.prepare(
    `${PLAYABLE}, x.id = (SELECT c.release_id FROM v_release_group_canonical c WHERE c.release_group_id = ?1) AS standard, t.disc, t.position
     FROM release x JOIN release_group g ON g.id = x.release_group_id
     JOIN track t ON t.release_id = x.id JOIN recording r ON r.id = t.recording_id
     ${fileJoin(spotify)}
     WHERE x.release_group_id = ?1 ${playableRow(spotify)}`,
  )
    .bind(albumId)
    .all<PlayableTrack & { standard: number; disc: number; position: number }>();
  // Each song once: as the standard edition has it, else as the first other edition does.
  const order = [...results].sort((a, b) => b.standard - a.standard || a.disc - b.disc || a.position - b.position);
  const seen = new Set<string>();
  return order
    .filter((t) => !seen.has(t.recordingId) && Boolean(seen.add(t.recordingId)))
    .map(({ standard: _s, disc: _d, position: _p, ...t }) => t);
}

/** One song, if you have its audio: for a track page, a long-press, or a song alone. */
export async function songQueue(recordingId: string, sources: QueueSources = {}): Promise<PlayableTrack[]> {
  return songsQueue([recordingId], sources);
}

/**
 * Songs you have audio for, in the order given (a playlist's), each once,
 * the rest left out: for playing a playlist from your own files.
 */
export async function songsQueue(recordingIds: string[], { spotify = false }: QueueSources = {}): Promise<PlayableTrack[]> {
  // Your files only: those you have audio for, found first. With Spotify, the query keeps
  // whichever of the two each song has.
  const playable = spotify ? null : await playableSongs(recordingIds);
  const ids = [...new Set(recordingIds.filter((id) => !playable || playable.has(id)))].slice(0, 500);
  if (ids.length === 0) return [];
  const { results } = await env.DB.prepare(
    `${PLAYABLE}
     FROM json_each(?1) j JOIN recording r ON r.id = j.value
     ${fileJoin(spotify)}
     LEFT JOIN v_recording_album ra ON ra.recording_id = r.id
     LEFT JOIN release_group g ON g.id = ra.release_group_id
     LEFT JOIN track t ON t.recording_id = r.id AND t.release_id = (SELECT c.release_id FROM v_release_group_canonical c WHERE c.release_group_id = g.id)
     LEFT JOIN release x ON x.id = t.release_id
     WHERE true ${playableRow(spotify)}`,
  )
    .bind(JSON.stringify(ids))
    .all<PlayableTrack>();
  const byId = new Map(results.map((r) => [r.recordingId, r]));
  return ids.map((id) => byId.get(id)).filter((t): t is PlayableTrack => t !== undefined);
}

/** Which of some songs you have audio for. */
export async function playableSongs(recordingIds: string[]): Promise<Set<string>> {
  if (recordingIds.length === 0) return new Set();
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT recording_id AS id FROM file WHERE audio_key IS NOT NULL AND recording_id IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(recordingIds))
    .all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}

/**
 * Removes uploaded audio (to free space): the stored copy goes; the file
 * stays catalogued, its original on Cillian's machine untouched. Returns
 * how many were removed.
 */
export async function removeAudio(fileIds: string[]): Promise<number> {
  if (fileIds.length === 0) return 0;
  const { results } = await env.DB.prepare(`SELECT id, audio_key FROM file WHERE audio_key IS NOT NULL AND id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(fileIds))
    .all<{ id: string; audio_key: string }>();
  if (results.length === 0) return 0;
  await env.AUDIO_STORE.delete(results.map((r) => r.audio_key));
  await env.DB.prepare(`UPDATE file SET audio_key = NULL, audio_bytes = NULL, uploaded_at = NULL WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(results.map((r) => r.id)))
    .run();
  return results.length;
}

/** How much audio is stored, for the upload page. */
export async function audioTotals(): Promise<{ files: number; bytes: number }> {
  const row = await env.DB.prepare(`SELECT count(*) AS files, coalesce(sum(audio_bytes), 0) AS bytes FROM file WHERE audio_key IS NOT NULL`).first<{
    files: number;
    bytes: number;
  }>();
  return row ?? { files: 0, bytes: 0 };
}

/**
 * A listen on the player (/play), logged as any other: its song's listen
 * track (keyed as Spotify or MusicBrainz would key it, so it pairs with
 * the same song heard there), then the play, counted from 30 seconds and
 * deduplicated with the rest (listens/store.ts). The source is "manual",
 * the site's own; the platform says "Your files".
 */
export async function logLocalPlay(userId: string, recordingId: string, playedAt: string, msPlayed: number): Promise<boolean> {
  const song = await env.DB.prepare(
    `SELECT r.title, r.spotify_id, r.mbid,
            (SELECT group_concat(a.name, ', ') FROM artist_credit c JOIN artist a ON a.id = c.artist_id
             WHERE c.entity_type = 'recording' AND c.entity_id = r.id AND c.role = 'primary') AS artist,
            (SELECT g.title FROM v_recording_album ra JOIN release_group g ON g.id = ra.release_group_id WHERE ra.recording_id = r.id) AS album
     FROM recording r WHERE r.id = ?`,
  )
    .bind(recordingId)
    .first<{ title: string; spotify_id: string | null; mbid: string | null; artist: string | null; album: string | null }>();
  if (!song) return false;
  const row = listenTrack({ artist: song.artist ?? 'Unknown', title: song.title, album: song.album, spotify_id: song.spotify_id, mbid: song.mbid });
  await env.DB.prepare(
    `INSERT INTO listen_track (key, artist, title, album, artist_key, title_key, spotify_id, mbid, recording_id, matched_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (key) DO UPDATE SET recording_id = coalesce(listen_track.recording_id, excluded.recording_id),
                                     matched_at = coalesce(listen_track.matched_at, excluded.matched_at)`,
  )
    .bind(row.key, row.artist, row.title, row.album, row.artist_key, row.title_key, row.spotify_id, row.mbid, recordingId)
    .run();
  const added = await savePlays(userId, 'manual', [{ track_key: row.key, played_at: playedAt, ms_played: Math.max(0, Math.round(msPlayed)), platform: 'Your files' }]);
  return added > 0;
}
