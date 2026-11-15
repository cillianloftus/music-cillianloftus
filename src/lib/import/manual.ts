/**
 * Manual entry (ARCHITECTURE.md §5, source ladder rung 5): paste a
 * tracklist rather than forty "add row" clicks. Builds an ImportPlan, so a
 * hand-typed album goes through the same writer, transaction and rules as
 * an import.
 */

import { env } from 'cloudflare:workers';
import { parsePartialDate } from '../dates';
import { normaliseTitle, withoutFeaturing } from '../text';
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
  /**
   * Lines that are songs already in the library, by "disc-position": the
   * song's id. Those lines place that song on the album instead of a new one.
   */
  existing?: Record<string, string>;
}

/** A line's key in ManualInput.existing. */
export const lineKey = (t: Pick<ParsedTrack, 'disc' | 'position'>) => `${t.disc}-${t.position}`;

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
      existing_id: input.existing?.[lineKey(track)] ?? null,
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

/** A song already here that a typed line may be. */
export interface ExistingSong {
  id: string;
  title: string;
  album_title: string | null;
  /** The viewer's score for it, when rated. */
  score: number | null;
}

/** How a line and a song are matched: the title, case, punctuation and guests aside. */
const songKey = (title: string) => normaliseTitle(withoutFeaturing(title));

/**
 * For each typed line, the songs by that artist (by name or alias) already
 * in the library with the same title: what the Add by hand preview offers
 * to reuse, so a release made from songs already here keeps their ratings,
 * plays and credits instead of copying them. Keyed by lineKey.
 */
export async function existingSongs(artistName: string, tracks: ParsedTrack[], viewerId: string | null): Promise<Record<string, ExistingSong[]>> {
  const name = artistName.trim();
  if (!name || tracks.length === 0) return {};
  const { results } = await env.DB.prepare(
    `WITH who AS (
       SELECT id FROM artist WHERE name = ?1 COLLATE NOCASE
       UNION SELECT artist_id FROM artist_alias WHERE name = ?1
     )
     SELECT DISTINCT r.id, r.title,
            (SELECT g.title FROM track t JOIN release x ON x.id = t.release_id JOIN release_group g ON g.id = x.release_group_id
             WHERE t.recording_id = r.id ORDER BY g.first_release_date LIMIT 1) AS album_title
     FROM who JOIN artist_credit c ON c.artist_id = who.id AND c.entity_type = 'recording' AND c.role = 'primary'
     JOIN recording r ON r.id = c.entity_id`,
  )
    .bind(name)
    .all<{ id: string; title: string; album_title: string | null }>();
  const wanted = new Set(tracks.map((t) => songKey(t.title)));
  const matching = results.filter((r) => wanted.has(songKey(r.title)));
  const scores = new Map<string, number>();
  if (viewerId && matching.length) {
    const { results: scored } = await env.DB.prepare(
      `SELECT recording_id, personal_score FROM v_recording_score WHERE user_id = ? AND recording_id IN (SELECT value FROM json_each(?))`,
    )
      .bind(viewerId, JSON.stringify(matching.map((m) => m.id)))
      .all<{ recording_id: string; personal_score: number }>();
    for (const r of scored) scores.set(r.recording_id, r.personal_score);
  }
  const out: Record<string, ExistingSong[]> = {};
  for (const t of tracks) {
    const same = matching
      .filter((m) => songKey(m.title) === songKey(t.title))
      .map((m) => ({ ...m, score: scores.get(m.id) ?? null }))
      // Rated first: the copy holding the ratings is the one to reuse.
      .sort((a, b) => Number(b.score !== null) - Number(a.score !== null) || (b.score ?? 0) - (a.score ?? 0));
    if (same.length) out[lineKey(t)] = same;
  }
  return out;
}

/**
 * All of an artist's songs (by name, or an alias), each with the release it
 * is on (an edition named for itself, "Vanisher, Horizon Scraper · The
 * Extended Cut"), for the builder to search on the device. The site's
 * search returns six songs across everything, so "finale" found Rent's and
 * never Quadeca's "i. finale" (15 Nov). No scores: reading them for a whole
 * catalogue builds the score view whole.
 */
export async function artistSongs(artistName: string): Promise<{ id: string; title: string; album: string | null }[]> {
  const name = artistName.trim();
  if (!name) return [];
  const { results } = await env.DB.prepare(
    `WITH who AS (
       SELECT id FROM artist WHERE name = ?1 COLLATE NOCASE
       UNION SELECT artist_id FROM artist_alias WHERE name = ?1
     ),
     songs AS (
       SELECT DISTINCT r.id, r.title FROM who
       JOIN artist_credit c ON c.artist_id = who.id AND c.entity_type = 'recording' AND c.role = 'primary'
       JOIN recording r ON r.id = c.entity_id
     )
     SELECT s.id, s.title,
            -- An edition without a name of its own first: only a song on a named one alone says which.
            (SELECT g.title || coalesce(' · ' || x.note, '')
             FROM track t JOIN release x ON x.id = t.release_id JOIN release_group g ON g.id = x.release_group_id
             WHERE t.recording_id = s.id ORDER BY g.first_release_date, x.note IS NOT NULL LIMIT 1) AS album
     FROM songs s
     LIMIT 3000`,
  )
    .bind(name)
    .all<{ id: string; title: string; album: string | null }>();
  return results;
}

/** Songs by id, as a line's choices show them: for songs picked in the builder by search, by any artist. */
export async function songsByIds(ids: string[], viewerId: string | null): Promise<Map<string, ExistingSong>> {
  if (ids.length === 0) return new Map();
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.title,
            (SELECT g.title FROM track t JOIN release x ON x.id = t.release_id JOIN release_group g ON g.id = x.release_group_id
             WHERE t.recording_id = r.id ORDER BY g.first_release_date LIMIT 1) AS album_title,
            (SELECT s.personal_score FROM v_recording_score s WHERE s.recording_id = r.id AND s.user_id = ?2) AS score
     FROM recording r WHERE r.id IN (SELECT value FROM json_each(?1))`,
  )
    .bind(JSON.stringify(ids), viewerId)
    .all<ExistingSong>();
  return new Map(results.map((r) => [r.id, r]));
}

/**
 * The chosen songs that still fit their lines: the same title (case,
 * punctuation and guests aside). A tracklist edited after its preview, or
 * a line moved, cannot put a song on the wrong track.
 */
export async function fittingChoices(existing: Record<string, string>, tracks: ParsedTrack[]): Promise<Record<string, string>> {
  const songs = await songsByIds(Object.values(existing), null);
  const titleOf = new Map(tracks.map((t) => [lineKey(t), songKey(t.title)]));
  return Object.fromEntries(
    Object.entries(existing).filter(([key, id]) => {
      const song = songs.get(id);
      return song !== undefined && titleOf.get(key) === songKey(song.title);
    }),
  );
}
