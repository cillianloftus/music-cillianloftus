/**
 * Manual entry (ARCHITECTURE.md §5, source ladder rung 5): paste a
 * tracklist rather than forty "add row" clicks. Builds an ImportPlan, so a
 * hand-typed album goes through the same writer, transaction and rules as
 * an import.
 */

import { parsePartialDate } from '../dates';
import type { ImportPlan, PlanArtist, PlanCredit, PlanRecording, PlanTrack, ReleaseGroupType } from './plan';

export const MAX_TRACKS = 200;

export interface ParsedTrack {
  disc: number;
  position: number;
  title: string;
  length_ms: number | null;
  featured: string[];
}

const DISC_HEADING = /^(?:disc|cd|disk)\s*(\d+)\b/i;
/** "3.", "3)", "3:", "3 -": unmistakably numbering. */
const PUNCTUATED_NUMBER = /^\d{1,3}\s*[.):\-–—]\s*/;
/** "A4": vinyl side and position. */
const SIDE_NUMBER = /^[A-H]\d{1,2}[.):-]?\s+/i;
/** "01 Title": numbering only if it is the next expected position. */
const BARE_NUMBER = /^(\d{1,3})\s+/;

/**
 * Strips leading track numbering without eating titles that start with a
 * number ("22 Acacia Avenue", "99 Luftballons"): a bare number only counts
 * as numbering when it is the position this track would have anyway.
 */
function stripNumbering(line: string, expected: number): string {
  if (PUNCTUATED_NUMBER.test(line)) return line.replace(PUNCTUATED_NUMBER, '');
  if (SIDE_NUMBER.test(line)) return line.replace(SIDE_NUMBER, '');
  const bare = BARE_NUMBER.exec(line);
  if (bare && Number(bare[1]) === expected) return line.slice(bare[0].length);
  return line;
}
const DURATION = /\s*[[(]?\s*(?:(\d{1,2}):)?(\d{1,3}):(\d{2})\s*[\])]?\s*$/;
const FEATURING_BRACKETED = /\s*[([]\s*(?:feat\.?|ft\.?|featuring|with)\s+([^)\]]+)[)\]]\s*$/i;
const FEATURING_TRAILING = /\s+(?:feat\.?|ft\.?|featuring)\s+(.+)$/i;

function splitNames(names: string): string[] {
  return names
    .split(/\s*(?:,|&|\band\b|\bx\b)\s*/i)
    .map((n) => n.trim())
    .filter(Boolean);
}

/** One track per line. Blank lines are ignored; "Disc 2" starts a new disc. */
export function parseTracklist(text: string): ParsedTrack[] {
  const tracks: ParsedTrack[] = [];
  let disc = 1;
  let position = 0;

  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;

    const heading = DISC_HEADING.exec(line);
    if (heading && line.length <= 12) {
      const next = Number(heading[1]);
      if (next !== disc && (tracks.length > 0 || next > 1)) {
        disc = next;
        position = 0;
      }
      continue;
    }

    line = stripNumbering(line, position + 1);

    let length_ms: number | null = null;
    const duration = DURATION.exec(line);
    if (duration && duration.index > 0) {
      const [, hours, minutes, seconds] = duration;
      length_ms = ((Number(hours ?? 0) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
      line = line.slice(0, duration.index).replace(/\s*[-–—]\s*$/, '');
    }

    let featured: string[] = [];
    const feat = FEATURING_BRACKETED.exec(line) ?? FEATURING_TRAILING.exec(line);
    if (feat) {
      featured = splitNames(feat[1]!);
      line = line.slice(0, feat.index);
    }

    const title = line.replace(/^["“]|["”]$/g, '').trim();
    if (!title) continue;
    tracks.push({ disc, position: ++position, title, length_ms, featured });
  }
  return tracks;
}

/** "The Beatles" sorts as "Beatles, The". */
export function sortName(name: string): string {
  const match = /^(the|a|an)\s+(.+)$/i.exec(name.trim());
  return match ? `${match[2]}, ${match[1]}` : name.trim();
}

export interface ManualInput {
  artist: string;
  title: string;
  type: ReleaseGroupType;
  date: string;
  genres: string;
  tracklist: string;
}

export function validateManual(input: ManualInput): string[] {
  const errors: string[] = [];
  if (!input.artist.trim()) errors.push('Give the artist.');
  if (!input.title.trim()) errors.push('Give the album title.');
  if (input.date.trim() && parsePartialDate(input.date).precision === 'unknown') {
    errors.push('Write the date as 2015, 2015-06 or 2015-06-30, or leave it empty.');
  }
  const count = parseTracklist(input.tracklist).length;
  if (count > MAX_TRACKS) errors.push(`At most ${MAX_TRACKS} tracks at once.`);
  return errors;
}

export function buildManualPlan(input: ManualInput): ImportPlan {
  const artistName = input.artist.trim();
  const title = input.title.trim();
  const date = parsePartialDate(input.date);
  const tracks = parseTracklist(input.tracklist);
  const today = new Date().toISOString().slice(0, 10);

  const artists = new Map<string, PlanArtist>();
  const artistKey = (name: string) => {
    const key = `artist:${name.toLowerCase()}`;
    if (!artists.has(key)) artists.set(key, { key, mbid: null, name, sort_name: sortName(name), disambiguation: null });
    return key;
  };
  const mainKey = artistKey(artistName);

  const credits: PlanCredit[] = [];
  const primary = (entity: PlanCredit['entity'], entity_key: string, joinPhrase = '') =>
    credits.push({ entity, entity_key, artist_key: mainKey, role: 'primary', position: 1, credited_as: null, join_phrase: joinPhrase });

  primary('release_group', 'release_group');
  primary('release', 'release');

  const recordings: PlanRecording[] = [];
  const planTracks: PlanTrack[] = [];
  for (const track of tracks) {
    const key = `recording:${track.disc}-${track.position}`;
    recordings.push({
      key,
      mbid: null,
      title: track.title,
      length_ms: track.length_ms,
      first_release_date: null,
      date_precision: 'unknown',
      isrc: null,
      work_key: null,
    });
    planTracks.push({ recording_key: key, disc: track.disc, position: track.position, title_on_release: null });

    primary('recording', key, track.featured.length > 0 ? ' feat. ' : '');
    track.featured.forEach((name, i) => {
      const last = i === track.featured.length - 1;
      credits.push({
        entity: 'recording',
        entity_key: key,
        artist_key: artistKey(name),
        role: 'featured',
        position: i + 1,
        credited_as: null,
        join_phrase: last ? '' : i === track.featured.length - 2 ? ' & ' : ', ',
      });
    });
  }

  const genres = [...new Set(input.genres.split(',').map((g) => g.trim().toLowerCase()).filter(Boolean))];

  return {
    source: 'manual',
    artists: [...artists.values()],
    works: [],
    recordings,
    releaseGroup: {
      key: 'release_group',
      mbid: null,
      title,
      type: input.type,
      status: date.date && date.date > today ? 'announced' : 'released',
      first_release_date: date.date,
      date_precision: date.precision,
    },
    release: {
      key: 'release',
      mbid: null,
      title,
      date: date.date,
      date_precision: date.precision,
      country: null,
      label: null,
      format: null,
    },
    tracks: planTracks,
    credits,
    releaseGroupGenres: genres.map((name) => ({ name, weight: 1 })),
  };
}
