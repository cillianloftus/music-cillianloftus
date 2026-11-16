/**
 * Import from local audio tags (ARCHITECTURE.md Â§5, rung 4). The browser
 * reads the tags; this side gets text only, never audio.
 *
 *   - An album tagged by MusicBrainz Picard carries its release MBID, so it
 *     goes through the full MusicBrainz import instead: better data than
 *     any tag. Its files are attached once that job has written it.
 *   - Anything else becomes an import plan with source 'files', written by
 *     the same writer as every other source.
 *
 * Either way each file is catalogued (path, format, bitrate, checksum)
 * against its recording. A folder whose files are already catalogued is
 * skipped, so importing the same folder twice adds nothing.
 */

import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { parsePartialDate } from '../dates';
import { createBatch, enqueue, PRIORITY } from '../jobs/queue';
import { groupAlbums, splitArtist, type AlbumGroup, type FileRecord } from '../tags/albums';
import { normaliseTitle, withoutCredits } from '../text';
import { sortName } from './manual';
import type { ImportPlan, PlanArtist, PlanCredit, PlanRecording, PlanTrack, ReleaseGroupType } from './plan';
import { writePlan } from './write';

export const MAX_FILES = 2000;

const text = z.string().trim().min(1).max(500).nullable();
const mbid = z.string().regex(/^[0-9a-f-]{36}$/).nullable();
const fileRecord = z
  .object({
    path: z.string().min(1).max(1000),
    size: z.number().int().nonnegative(),
    checksum: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    format: z.enum(['mp3', 'flac', 'ogg', 'opus', 'm4a']),
    title: text,
    artist: text,
    albumArtist: text,
    album: text,
    track: z.number().int().positive().max(999).nullable(),
    disc: z.number().int().positive().max(99).nullable(),
    date: z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/).nullable(),
    lengthMs: z.number().int().positive().nullable(),
    mbReleaseId: mbid,
    mbRecordingId: mbid,
    releaseType: z.string().max(100).nullable(),
  })
  .strict();

export const filesPayload = z
  .object({
    /** Optional folder location on the owner's machine, prefixed to every path. */
    root: z.string().trim().max(500).default(''),
    files: z.array(fileRecord).min(1).max(MAX_FILES),
    /**
     * What Cillian confirmed for each album (by groupAlbums key): the album
     * already held that it is, or 'new' to add it. An album with no answer
     * still joins one held under the same artist and title rather than
     * becoming a second copy.
     */
    choices: z.record(z.string().max(2000), z.string().max(64)).default({}),
  })
  .strict();

/** An album already in the library that a folder might be, for Cillian to confirm. */
export interface Candidate {
  id: string;
  title: string;
  artist: string;
  type: string;
  year: string | null;
  tracks: number;
  /** Cover, a small WebP. */
  art: string | null;
  /** How many of the folder's song titles are on it. */
  shared: number;
  /** Sure enough to be chosen unless Cillian says otherwise. */
  likely: boolean;
}

export const albumQuestion = z.object({
  albums: z
    .array(z.object({ key: z.string().max(2000), artist: z.string().max(500), title: z.string().max(500), tracks: z.array(z.string().max(500)).max(200) }))
    .max(500),
});

/**
 * The albums already held that a folder might be: by the tagged artist (or
 * an alias of theirs) with the same title, or one title inside the other
 * ("Welcome To Forever", "Young Sinatra: Welcome to Forever"); and any
 * album, whoever it is credited to, holding half or more of the folder's
 * songs by title (so a folder tagged "Logic_Inglorious_Basterd" still finds
 * Logic's album). Best first, at most three.
 */
export async function albumCandidates(album: { artist: string; title: string; tracks: string[] }): Promise<Candidate[]> {
  const db = env.DB;
  const names = [...new Set([album.artist, splitArtist(album.artist).primary].map((n) => n.trim()).filter(Boolean))];
  const songKey = (t: string) => normaliseTitle(withoutCredits(t));
  const titles = [...new Set(album.tracks.flatMap((t) => [t, withoutCredits(t)]).map((t) => t.trim()).filter(Boolean))];
  const [byArtist, bySongs] = await db.batch<{ id: string; title?: string; song?: string }>([
    db
      .prepare(
        `WITH who AS (
           SELECT a.id FROM json_each(?1) j JOIN artist a ON a.name = j.value COLLATE NOCASE
           UNION SELECT x.artist_id FROM json_each(?1) j JOIN artist_alias x ON x.name = j.value COLLATE NOCASE
         )
         SELECT DISTINCT g.id, g.title FROM who
         JOIN artist_credit c ON c.artist_id = who.id AND c.entity_type = 'release_group' AND c.role = 'primary'
         JOIN release_group g ON g.id = c.entity_id`,
      )
      .bind(JSON.stringify(names)),
    db
      .prepare(
        `SELECT DISTINCT e.release_group_id AS id, r.title AS song
         FROM recording r JOIN track t ON t.recording_id = r.id JOIN release e ON e.id = t.release_id
         WHERE r.title COLLATE NOCASE IN (SELECT value FROM json_each(?))`,
      )
      .bind(JSON.stringify(titles.length ? titles : [''])),
  ]);

  const want = normaliseTitle(album.title);
  const artistAlbums = new Map(byArtist!.results.map((g) => [g.id, normaliseTitle(g.title ?? '')]));
  const folderSongs = new Set(album.tracks.map(songKey));
  const shared = new Map<string, Set<string>>();
  for (const row of bySongs!.results) {
    const k = songKey(row.song ?? '');
    if (!folderSongs.has(k)) continue;
    shared.set(row.id, (shared.get(row.id) ?? new Set()).add(k));
  }

  const n = Math.max(1, folderSongs.size);
  const scored: { id: string; score: number; shared: number; likely: boolean }[] = [];
  for (const id of new Set([...artistAlbums.keys(), ...shared.keys()])) {
    const title = artistAlbums.get(id);
    const hits = shared.get(id)?.size ?? 0;
    const exact = title !== undefined && title === want;
    const inside = title !== undefined && Math.min(title.length, want.length) >= 4 && (title.includes(want) || want.includes(title));
    const share = hits / n;
    // Songs alone: half the folder, and at least two unless the artist agrees too.
    const bySongsOnly = share >= 0.5 && (hits >= 2 || title !== undefined);
    if (!exact && !inside && !bySongsOnly) continue;
    const score = (exact ? 100 : inside ? 60 : 0) + 50 * share;
    scored.push({ id, score, shared: hits, likely: exact || (inside && share >= 0.5) || share >= 0.8 });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 3);
  if (top.length === 0) return [];

  const { results: details } = await db
    .prepare(
      `SELECT g.id, g.title, g.type, substr(g.first_release_date, 1, 4) AS year,
              (SELECT group_concat(coalesce(c.credited_as, a.name) || c.join_phrase, '') FROM artist_credit c JOIN artist a ON a.id = c.artist_id
               WHERE c.entity_type = 'release_group' AND c.entity_id = g.id AND c.role = 'primary' ORDER BY c.position) AS artist,
              (SELECT count(*) FROM track t WHERE t.release_id = coalesce(g.preferred_release_id, (SELECT min(e.id) FROM release e WHERE e.release_group_id = g.id))) AS tracks,
              (SELECT e.art_key FROM release e WHERE e.release_group_id = g.id AND e.art_key IS NOT NULL
               ORDER BY e.id = g.preferred_release_id DESC LIMIT 1) AS art_key
       FROM release_group g WHERE g.id IN (SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(top.map((t) => t.id)))
    .all<{ id: string; title: string; type: string; year: string | null; artist: string | null; tracks: number; art_key: string | null }>();
  const byId = new Map(details.map((d) => [d.id, d]));
  // Only the best can be preselected, and only when nothing close rivals it.
  return top.flatMap((t, i) => {
    const d = byId.get(t.id);
    if (!d) return [];
    return [
      {
        id: d.id,
        title: d.title,
        artist: d.artist ?? '',
        type: d.type,
        year: d.year,
        tracks: d.tracks,
        art: d.art_key ? `/${d.art_key}/128.webp` : null,
        shared: t.shared,
        likely: i === 0 && t.likely,
      },
    ];
  });
}

/** One file to catalogue once its release exists. */
export interface FileAttachment {
  path: string;
  format: string;
  bitrate: number | null;
  checksum: string | null;
  disc: number;
  position: number;
  mbRecordingId: string | null;
}

export function releaseGroupType(tag: string | null): ReleaseGroupType {
  const t = tag ?? '';
  for (const type of ['compilation', 'live', 'soundtrack', 'mixtape', 'ep', 'single'] as const) {
    if (new RegExp(`\\b${type}\\b`).test(t)) return type;
  }
  return 'album';
}

export function buildFilesPlan(album: AlbumGroup): ImportPlan {
  const date = parsePartialDate(album.date ?? '');
  const today = new Date().toISOString().slice(0, 10);

  const artists = new Map<string, PlanArtist>();
  const artistKey = (name: string) => {
    const key = `artist:${name.toLowerCase()}`;
    if (!artists.has(key)) artists.set(key, { key, mbid: null, name, sort_name: sortName(name), disambiguation: null });
    return key;
  };
  const credits: PlanCredit[] = [];
  const credit = (entity: PlanCredit['entity'], entity_key: string, name: string, role: PlanCredit['role'], position: number, join_phrase: string) =>
    credits.push({ entity, entity_key, artist_key: artistKey(name), role, position, credited_as: null, join_phrase });

  credit('release_group', 'release_group', album.artist, 'primary', 1, '');
  credit('release', 'release', album.artist, 'primary', 1, '');

  const recordings: PlanRecording[] = [];
  const tracks: PlanTrack[] = [];
  for (const track of album.tracks) {
    const key = `recording:${track.disc}-${track.position}`;
    recordings.push({
      key,
      mbid: null,
      title: track.title,
      length_ms: track.file.lengthMs,
      first_release_date: null,
      date_precision: 'unknown',
      isrc: null,
      work_key: null,
    });
    tracks.push({ recording_key: key, disc: track.disc, position: track.position, title_on_release: null });
    const { primary, featured } = splitArtist(track.artist);
    credit('recording', key, primary, 'primary', 1, featured.length ? ' feat. ' : '');
    featured.forEach((name, i) =>
      credit('recording', key, name, 'featured', i + 1, i === featured.length - 1 ? '' : i === featured.length - 2 ? ' & ' : ', '),
    );
  }

  return {
    source: 'files',
    artists: [...artists.values()],
    works: [],
    recordings,
    releaseGroup: {
      key: 'release_group',
      mbid: null,
      title: album.title,
      type: releaseGroupType(album.releaseType),
      status: date.date && date.date > today ? 'announced' : 'released',
      first_release_date: date.date,
      date_precision: date.precision,
    },
    release: {
      key: 'release',
      mbid: null,
      title: album.title,
      date: date.date,
      date_precision: date.precision,
      country: null,
      label: null,
      format: 'Digital Media',
    },
    tracks,
    credits,
    releaseGroupGenres: [],
  };
}

export function attachmentsFor(album: AlbumGroup, root: string): FileAttachment[] {
  const prefix = root.replace(/[\\/]+$/, '');
  return album.tracks.map((t) => ({
    path: prefix ? `${prefix}/${t.file.path}` : t.file.path,
    format: t.file.format,
    bitrate: t.bitrate,
    checksum: t.file.checksum,
    disc: t.disc,
    position: t.position,
    mbRecordingId: t.file.mbRecordingId,
  }));
}

/**
 * Catalogues files against a written release: by recording MBID where the
 * tags carry one and it is held, else by disc and position on the release.
 * A path already catalogued is left as it is. Returns how many were added.
 */
export async function attachFiles(releaseId: string, files: FileAttachment[]): Promise<number> {
  if (files.length === 0) return 0;
  const rows = files.map((f) => ({ ...f, id: crypto.randomUUID() }));
  const result = await env.DB.prepare(
    `WITH incoming AS (
       SELECT f.value ->> '$.id' AS id,
              coalesce(
                (SELECT r.id FROM recording r WHERE r.mbid = f.value ->> '$.mbRecordingId'),
                (SELECT t.recording_id FROM track t
                 WHERE t.release_id = ?1 AND t.disc = f.value ->> '$.disc' AND t.position = f.value ->> '$.position')
              ) AS recording_id,
              f.value ->> '$.path' AS path,
              f.value ->> '$.format' AS format,
              f.value ->> '$.bitrate' AS bitrate,
              f.value ->> '$.checksum' AS checksum
       FROM json_each(?2) f
     )
     INSERT INTO file (id, recording_id, path, format, bitrate, checksum)
     SELECT id, recording_id, path, format, bitrate, checksum FROM incoming
     WHERE recording_id IS NOT NULL
     ON CONFLICT (path) DO NOTHING`,
  )
    .bind(releaseId, JSON.stringify(rows))
    .run();
  return result.meta.changes ?? 0;
}

/**
 * The album already in the library that a folder of files is: one credited
 * to an artist of the tagged name (or an alias of theirs) with the same
 * title, case and punctuation aside ("Welcome To Forever" is "Welcome to
 * Forever"). The one with MusicBrainz behind it first, then the oldest.
 */
export async function heldAlbum(album: Pick<AlbumGroup, 'artist' | 'title'>): Promise<string | null> {
  const names = [...new Set([album.artist, splitArtist(album.artist).primary].map((n) => n.trim()).filter(Boolean))];
  const { results } = await env.DB.prepare(
    `WITH who AS (
       SELECT a.id FROM json_each(?1) j JOIN artist a ON a.name = j.value COLLATE NOCASE
       UNION SELECT x.artist_id FROM json_each(?1) j JOIN artist_alias x ON x.name = j.value COLLATE NOCASE
     )
     SELECT DISTINCT g.id, g.title, g.mbid IS NOT NULL AS mb, g.created_at
     FROM who JOIN artist_credit c ON c.artist_id = who.id AND c.entity_type = 'release_group' AND c.role = 'primary'
     JOIN release_group g ON g.id = c.entity_id`,
  )
    .bind(JSON.stringify(names))
    .all<{ id: string; title: string; mb: number; created_at: string }>();
  const want = normaliseTitle(album.title);
  const same = results.filter((g) => normaliseTitle(g.title) === want).sort((a, b) => b.mb - a.mb || a.created_at.localeCompare(b.created_at));
  return same[0]?.id ?? null;
}

/**
 * Catalogues a folder's files against an album already held, creating
 * nothing: each file to the album's song of the same title (featured
 * artists aside), else, when the folder and an edition have the same number
 * of tracks, to the song at its disc and position. Returns how many files
 * were catalogued and how many found no song.
 */
export async function attachToHeldAlbum(albumId: string, album: AlbumGroup, files: FileAttachment[]): Promise<{ attached: number; unmatched: number }> {
  const { results: tracks } = await env.DB.prepare(
    `SELECT t.recording_id, coalesce(t.title_on_release, r.title) AS title, r.title AS song, t.disc, t.position, e.id AS release_id,
            e.id = g.preferred_release_id AS preferred
     FROM release_group g JOIN release e ON e.release_group_id = g.id JOIN track t ON t.release_id = e.id JOIN recording r ON r.id = t.recording_id
     WHERE g.id = ?
     ORDER BY preferred DESC, e.id, t.disc, t.position`,
  )
    .bind(albumId)
    .all<{ recording_id: string; title: string; song: string; disc: number; position: number; release_id: string; preferred: number }>();
  const key = (title: string) => normaliseTitle(withoutCredits(title));
  const byTitle = new Map<string, string>();
  for (const t of tracks) for (const k of [key(t.title), key(t.song)]) if (!byTitle.has(k)) byTitle.set(k, t.recording_id);
  const counts = new Map<string, number>();
  for (const t of tracks) counts.set(t.release_id, (counts.get(t.release_id) ?? 0) + 1);
  const sameLength = [...counts].find(([, n]) => n === album.tracks.length)?.[0];
  const byPosition = new Map(tracks.filter((t) => t.release_id === sameLength).map((t) => [`${t.disc}-${t.position}`, t.recording_id]));

  const rows = album.tracks.flatMap((track, i) => {
    const file = files[i]!;
    const recordingId = byTitle.get(key(track.title)) ?? byPosition.get(`${track.disc}-${track.position}`);
    return recordingId ? [{ id: crypto.randomUUID(), recording_id: recordingId, path: file.path, format: file.format, bitrate: file.bitrate, checksum: file.checksum }] : [];
  });
  if (rows.length === 0) return { attached: 0, unmatched: album.tracks.length };
  const result = await env.DB.prepare(
    `INSERT INTO file (id, recording_id, path, format, bitrate, checksum)
     SELECT value ->> '$.id', value ->> '$.recording_id', value ->> '$.path', value ->> '$.format', value ->> '$.bitrate', value ->> '$.checksum'
     FROM json_each(?) WHERE true
     ON CONFLICT (path) DO NOTHING`,
  )
    .bind(JSON.stringify(rows))
    .run();
  return { attached: result.meta.changes ?? 0, unmatched: album.tracks.length - rows.length };
}

export interface AlbumOutcome {
  title: string;
  artist: string;
  tracks: number;
  status: 'added' | 'matched' | 'queued' | 'skipped';
  /** Where to look: the album page, or the jobs page for a queued import. */
  href: string | null;
  note: string | null;
}

export async function importFiles(input: z.input<typeof filesPayload>): Promise<AlbumOutcome[]> {
  const albums = groupAlbums(input.files as FileRecord[]);
  const outcomes: AlbumOutcome[] = [];
  // Imports from MusicBrainz tags: one batch on the Jobs page (0072), made when the first is queued.
  let batch: string | null = null;

  for (const album of albums) {
    const files = attachmentsFor(album, input.root ?? '');
    const base = { title: album.title, artist: album.artist, tracks: album.tracks.length };
    const catalogued = await env.DB.prepare(
      `SELECT count(*) AS n FROM file WHERE path IN (SELECT value FROM json_each(?))`,
    )
      .bind(JSON.stringify(files.map((f) => f.path)))
      .first<number>('n');
    if (catalogued) {
      outcomes.push({ ...base, status: 'skipped', href: null, note: `${catalogued} of these files are already catalogued.` });
      continue;
    }

    // Already in the library (most of what is on disk is): the files join
    // it; nothing new is made. Cillian's answer first; with none, the album
    // held under the same artist and title.
    const choice = input.choices?.[album.key];
    if (choice && choice !== 'new') {
      const exists = await env.DB.prepare(`SELECT 1 FROM release_group WHERE id = ?`).bind(choice).first();
      if (!exists) {
        outcomes.push({ ...base, status: 'skipped', href: null, note: 'The album chosen for these files is no longer in the library. Choose the folder again.' });
        continue;
      }
    }
    const held = choice === 'new' ? null : (choice ?? (await heldAlbum(album)));
    if (held) {
      const { attached, unmatched } = await attachToHeldAlbum(held, album, files);
      outcomes.push({
        ...base,
        status: 'matched',
        href: `/album/${held}`,
        note: `Already in your library: ${attached} ${attached === 1 ? 'file' : 'files'} catalogued against its songs${unmatched ? `, ${unmatched} matched no song on it` : ''}.`,
      });
      continue;
    }

    if (album.mbReleaseId) {
      batch ??= await createBatch('From your files', 'files');
      await enqueue('import_release', { source: 'musicbrainz', target: { entity: 'release', mbid: album.mbReleaseId }, files, label: album.title }, PRIORITY.asked, batch);
      outcomes.push({ ...base, status: 'queued', href: '/manage/jobs', note: 'Tagged by MusicBrainz, so imported from there.' });
      continue;
    }

    const written = await writePlan(buildFilesPlan(album));
    await attachFiles(written.releaseId, files);
    outcomes.push({ ...base, status: 'added', href: `/album/${written.releaseGroupId}`, note: album.notes.join(' ') || null });
  }
  return outcomes;
}

export interface CataloguedFile {
  id: string;
  path: string;
  format: string;
  bitrate: number | null;
  checksum: string | null;
  title: string;
  album_id: string | null;
  album_title: string | null;
  /** Its audio, when uploaded (src/lib/audio.ts): the size kept. */
  audio_bytes: number | null;
}

/** Every catalogued file, by path, with what it is a recording of. */
export async function catalogue(): Promise<CataloguedFile[]> {
  const { results } = await env.DB.prepare(
    `SELECT f.id, f.path, f.format, f.bitrate, f.checksum, r.title, ra.release_group_id AS album_id, g.title AS album_title,
            CASE WHEN f.audio_key IS NOT NULL THEN f.audio_bytes END AS audio_bytes
     FROM file f
     JOIN recording r ON r.id = f.recording_id
     LEFT JOIN v_recording_album ra ON ra.recording_id = r.id
     LEFT JOIN release_group g ON g.id = ra.release_group_id
     ORDER BY f.path`,
  ).all<CataloguedFile>();
  return results;
}
