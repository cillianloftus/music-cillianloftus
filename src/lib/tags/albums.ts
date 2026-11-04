/**
 * Groups tagged files into albums. Shared by the page (to preview) and the
 * server (to write), so what is shown is what is added. The server never
 * trusts the browser's grouping; it groups the raw records again.
 */

import { normaliseTitle } from '../text';
import type { AudioFormat, Tags } from './read';

export interface FileRecord extends Tags {
  /** Where the file lives, relative to the folder chosen (plus any root given). */
  path: string;
  size: number;
  /** SHA-256, hex, so a missing or corrupted rip is detectable later. */
  checksum: string | null;
}

export interface AlbumTrack {
  file: FileRecord;
  title: string;
  artist: string;
  disc: number;
  position: number;
  /** kbps, worked out from size and length. */
  bitrate: number | null;
}

export interface AlbumGroup {
  key: string;
  artist: string;
  title: string;
  date: string | null;
  mbReleaseId: string | null;
  releaseType: string | null;
  tracks: AlbumTrack[];
  /** Things guessed rather than read, shown in the preview. */
  notes: string[];
}

export const VARIOUS_ARTISTS = 'Various Artists';

/** "A feat. B & C" → primary A, featured [B, C]. */
export function splitArtist(value: string): { primary: string; featured: string[] } {
  const [primary, rest] = value.split(/\s+(?:feat\.?|ft\.?|featuring)\s+/i, 2);
  return {
    primary: primary!.trim(),
    featured: rest ? rest.split(/\s*(?:,|&|\band\b)\s*/i).map((s) => s.trim()).filter(Boolean) : [],
  };
}


const folderOf = (path: string) => path.split('/').slice(0, -1).join('/');
const fileName = (path: string) => path.split('/').at(-1) ?? path;
const baseName = (path: string) => fileName(path).replace(/\.[^.]+$/, '');

/** "03 - Song Title" → "Song Title". */
const titleFromFileName = (path: string) => baseName(path).replace(/^\s*\d{1,3}\s*[-–._)\s]\s*/, '').trim() || baseName(path);

function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** "Artist - Thing" → ["Artist", "Thing"]; null without a spaced dash. */
function splitDash(name: string): [string, string] | null {
  const match = /^(.+?)\s+[-–]\s+(.+)$/.exec(name);
  return match ? [match[1]!.trim(), match[2]!.trim()] : null;
}

/**
 * What the names say when the tags are silent: folders are very often
 * "Artist - Album" and files "NN - Artist - Title". Tags always win.
 */
function withNameFallbacks(file: FileRecord): FileRecord & { fromNames: boolean } {
  const folder = fileName(folderOf(file.path));
  const folderParts = splitDash(folder);
  const nameParts = splitDash(titleFromFileName(file.path));
  let fromNames = false;
  const out = { ...file };
  if (!out.album && folderParts) {
    out.album = folderParts[1];
    out.albumArtist ??= folderParts[0];
    fromNames = true;
  }
  if (!out.title && nameParts) {
    out.title = nameParts[1];
    out.artist ??= nameParts[0];
    fromNames = true;
  }
  return { ...out, fromNames };
}

const pathOrder = (a: FileRecord, b: FileRecord) => a.path.localeCompare(b.path, undefined, { numeric: true });

export function groupAlbums(records: FileRecord[]): AlbumGroup[] {
  const buckets = new Map<string, FileRecord[]>();
  for (const record of records) {
    // Picard's release id is exact; otherwise album title within a folder, or
    // else the folder. Not the artist: track artists differ on any album with
    // a guest or a compilation, and that must not split it.
    const key = record.mbReleaseId
      ? `mb:${record.mbReleaseId}`
      : record.album
        ? `tag:${normaliseTitle(record.album)}|${folderOf(record.path)}`
        : `dir:${folderOf(record.path)}`;
    const list = buckets.get(key);
    if (list) list.push(record);
    else buckets.set(key, [record]);
  }

  return [...buckets].map(([key, originals]) => {
    const files = originals.map(withNameFallbacks);
    files.sort((a, b) => (a.disc ?? 1) - (b.disc ?? 1) || (a.track ?? 1e9) - (b.track ?? 1e9) || pathOrder(a, b));
    const notes: string[] = [];

    const albumArtists = [...new Set(files.map((f) => f.albumArtist).filter((a): a is string => a !== null))];
    // Compared without guests: "A feat. B" is still A's track.
    const trackArtists = [...new Set(files.map((f) => f.artist).filter((a): a is string => a !== null).map((a) => splitArtist(a).primary))];
    let artist = mostCommon(files.map((f) => f.albumArtist).filter((a): a is string => a !== null));
    if (!artist) {
      if (trackArtists.length > 1) {
        artist = VARIOUS_ARTISTS;
        notes.push('No album artist tag and several track artists, so filed under Various Artists.');
      } else {
        artist = trackArtists[0] ?? 'Unknown artist';
      }
    }
    if (albumArtists.length > 1) notes.push(`Album artist differs between files; using ${artist}.`);
    if (artist === 'Unknown artist') notes.push('No artist tags.');

    let title = mostCommon(files.map((f) => f.album).filter((a): a is string => a !== null));
    if (!title) {
      title = fileName(folderOf(files[0]!.path)) || 'Untitled';
      notes.push('No album tag; named after the folder.');
    }

    // Positions: as tagged, unless missing or clashing, then by file order.
    const seen = new Set<string>();
    let clash = false;
    for (const f of files) {
      const slot = `${f.disc ?? 1}-${f.track}`;
      if (f.track === null || seen.has(slot)) clash = true;
      seen.add(slot);
    }
    if (clash) notes.push('Track numbers missing or repeated; numbered in file order.');
    const counters = new Map<number, number>();
    const tracks = files.map((file) => {
      const disc = file.disc ?? 1;
      const position = clash ? (counters.get(disc) ?? 0) + 1 : file.track!;
      counters.set(disc, position);
      const bitrate = file.lengthMs && file.lengthMs > 0 ? Math.round((file.size * 8) / file.lengthMs) : null;
      return {
        // The record as read, not the fallbacks: those only feed titles and artists.
        file: originals.find((o) => o.path === file.path)!,
        title: file.title ?? titleFromFileName(file.path),
        artist: file.artist ?? artist!,
        disc,
        position,
        bitrate: bitrate && bitrate > 0 ? bitrate : null,
      };
    });
    if (files.some((f) => f.fromNames)) notes.push('Artist, album or titles read from folder and file names.');
    if (files.some((f) => f.title === null)) notes.push('Some titles are just the file name.');

    const dates = files.map((f) => f.date).filter((d): d is string => d !== null);
    return {
      key,
      artist,
      title,
      date: mostCommon(dates),
      mbReleaseId: key.startsWith('mb:') ? key.slice(3) : null,
      releaseType: mostCommon(files.map((f) => f.releaseType).filter((t): t is string => t !== null)),
      tracks,
      notes,
    };
  });
}

export const AUDIO_EXTENSIONS: Record<string, AudioFormat> = {
  mp3: 'mp3',
  flac: 'flac',
  ogg: 'ogg',
  oga: 'ogg',
  opus: 'opus',
  m4a: 'm4a',
  mp4: 'm4a',
  alac: 'm4a',
};
