/**
 * Import from local audio tags (ARCHITECTURE.md §5, rung 4). The browser
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
import { enqueue } from '../jobs/queue';
import { groupAlbums, splitArtist, type AlbumGroup, type FileRecord } from '../tags/albums';
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
  })
  .strict();

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

export interface AlbumOutcome {
  title: string;
  artist: string;
  tracks: number;
  status: 'added' | 'queued' | 'skipped';
  /** Where to look: the album page, or the jobs page for a queued import. */
  href: string | null;
  note: string | null;
}

export async function importFiles(input: z.infer<typeof filesPayload>): Promise<AlbumOutcome[]> {
  const albums = groupAlbums(input.files as FileRecord[]);
  const outcomes: AlbumOutcome[] = [];

  for (const album of albums) {
    const files = attachmentsFor(album, input.root);
    const base = { title: album.title, artist: album.artist, tracks: album.tracks.length };
    const held = await env.DB.prepare(
      `SELECT count(*) AS n FROM file WHERE path IN (SELECT value FROM json_each(?))`,
    )
      .bind(JSON.stringify(files.map((f) => f.path)))
      .first<number>('n');
    if (held) {
      outcomes.push({ ...base, status: 'skipped', href: null, note: `${held} of these files are already catalogued.` });
      continue;
    }

    if (album.mbReleaseId) {
      await enqueue('import_release', { source: 'musicbrainz', target: { entity: 'release', mbid: album.mbReleaseId }, files, label: album.title });
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
  path: string;
  format: string;
  bitrate: number | null;
  checksum: string | null;
  title: string;
  album_id: string | null;
  album_title: string | null;
}

/** Every catalogued file, by path, with what it is a recording of. */
export async function catalogue(): Promise<CataloguedFile[]> {
  const { results } = await env.DB.prepare(
    `SELECT f.path, f.format, f.bitrate, f.checksum, r.title, ra.release_group_id AS album_id, g.title AS album_title
     FROM file f
     JOIN recording r ON r.id = f.recording_id
     LEFT JOIN v_recording_album ra ON ra.recording_id = r.id
     LEFT JOIN release_group g ON g.id = ra.release_group_id
     ORDER BY f.path`,
  ).all<CataloguedFile>();
  return results;
}
