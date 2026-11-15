/**
 * What the catalogue does not know yet, as prompts: albums without a date
 * or genres or a Spotify link, tracks with no writer, people without a
 * birthday. Unlike review anomalies these are not wrong, only incomplete,
 * so they are computed on the spot and never stored or dismissed.
 *
 * Albums come first where something has been rated: gaps in what Cillian
 * listens to matter more than gaps in what was imported in passing.
 */

import { env } from 'cloudflare:workers';
import { byStamp } from './library-cache';

export interface Gap {
  id: string;
  title: string;
  detail: string | null;
  href: string;
}

export interface GapGroup {
  key: string;
  heading: string;
  explain: string;
  total: number;
  items: Gap[];
}

const SHOWN = 8;

// The albums with any rating, on them or a track of theirs: one list worked
// out once per statement (an uncorrelated IN), where a check per album
// with an OR in it walked the ratings for each (129,000 rows for one list).
const RATED_FIRST = `g.id IN (SELECT entity_id FROM rating WHERE entity_type = 'release_group'
                            UNION SELECT rr.release_group_id FROM rating x
                                  JOIN track t ON t.recording_id = x.entity_id
                                  JOIN release rr ON rr.id = t.release_id
                                  WHERE x.entity_type = 'recording') DESC`;

/** An album's artists, for the few rows shown (p.id), not every album counted. */
const albumArtist = `(SELECT group_concat(a.name, ', ') FROM artist_credit c JOIN artist a ON a.id = c.artist_id
                      WHERE c.entity_type = 'release_group' AND c.entity_id = p.id AND c.role = 'primary')`;

/**
 * Kept for the hour, or until something is edited or merged by hand (what
 * fills a gap; moves the stamp at once). Worked out on every visit, the
 * six lists read about 300,000 rows; kept until the library changed, they
 * were worked out again after every import (113 times on 15 Nov, 75
 * million rows), though an import only adds to the lists' far end.
 */
export async function missingInfo(now = new Date()): Promise<GapGroup[]> {
  const row = await env.DB.prepare(
    `SELECT (SELECT max(edited_at) FROM field_override) AS edits, (SELECT max(rowid) FROM entity_redirect) AS merges`,
  ).first<{ edits: string | null; merges: number | null }>();
  return byStamp('missing-info', [now.toISOString().slice(0, 13), row?.edits, row?.merges].join(':'), workOutMissingInfo);
}

async function workOutMissingInfo(): Promise<GapGroup[]> {
  // The count over everything, the artist names only for the SHOWN rows.
  const page = (sql: string, artists = true) =>
    env.DB.prepare(
      `SELECT p.*, ${artists ? albumArtist : 'NULL'} AS artist
       FROM (SELECT count(*) OVER () AS total, * FROM (${sql}) LIMIT ${SHOWN}) p`,
    );
  const [writers, dates, genres, spotify, births, kinds] = await env.DB.batch([
    page(
      `SELECT g.id, g.title, count(*) AS n, sum(count(*)) OVER () AS tracks
       FROM release_group g
       JOIN v_release_group_canonical c ON c.release_group_id = g.id
       JOIN track t ON t.release_id = c.release_id
       WHERE NOT EXISTS (SELECT 1 FROM artist_credit w WHERE w.entity_type = 'recording' AND w.entity_id = t.recording_id AND w.role IN (SELECT id FROM credit_role WHERE family = 'writing'))
       GROUP BY g.id
       ORDER BY ${RATED_FIRST}, n DESC, g.title`,
    ),
    page(
      `SELECT g.id, g.title FROM release_group g
       WHERE g.first_release_date IS NULL AND g.status = 'released'
       ORDER BY ${RATED_FIRST}, g.title`,
    ),
    page(
      `SELECT g.id, g.title FROM release_group g
       WHERE NOT EXISTS (SELECT 1 FROM genre_tag t WHERE t.entity_type = 'release_group' AND t.entity_id = g.id)
       ORDER BY ${RATED_FIRST}, g.title`,
    ),
    page(
      `SELECT g.id, g.title FROM release_group g
       WHERE g.spotify_id IS NULL AND g.status = 'released' AND coalesce(g.availability, '') <> 'unreleased'
       ORDER BY ${RATED_FIRST}, g.title`,
    ),
    page(
      `SELECT a.id, a.name AS title FROM artist a
       WHERE a.kind = 'person' AND a.begin_date IS NULL
       ORDER BY (SELECT count(*) FROM artist_credit c WHERE c.artist_id = a.id AND c.role = 'primary') DESC, a.sort_name`,
      false,
    ),
    page(
      `SELECT a.id, a.name AS title FROM artist a
       WHERE a.kind IS NULL
         AND EXISTS (SELECT 1 FROM artist_credit c WHERE c.artist_id = a.id AND c.role = 'primary')
       ORDER BY (SELECT count(*) FROM artist_credit c WHERE c.artist_id = a.id AND c.role = 'primary') DESC, a.sort_name`,
      false,
    ),
  ]);

  type Row = { total: number; id: string; title: string; artist: string | null; n?: number; tracks?: number };
  const rows = (r: D1Result | undefined) => (r?.results ?? []) as Row[];
  const group = (key: string, heading: string, explain: string, result: D1Result | undefined, item: (row: Row) => Gap): GapGroup => {
    const list = rows(result);
    return { key, heading, explain, total: list[0]?.total ?? 0, items: list.map(item) };
  };
  const album = (path: (id: string) => string, detail?: (r: Row) => string) => (r: Row) => ({
    id: r.id,
    title: r.title,
    detail: detail ? detail(r) : r.artist,
    href: path(r.id),
  });

  return [
    group(
      'writers',
      'Tracks with no writer',
      'MusicBrainz often has no songwriting credits for newer or smaller records. Credit a writer across an album, or track by track.',
      writers,
      album(
        (id) => `/edit/album/${id}`,
        (r) => [r.artist, `${r.n} ${r.n === 1 ? 'track' : 'tracks'}`].filter(Boolean).join(' · '),
      ),
    ),
    group('dates', 'Albums with no release date', 'Anniversaries and the decade chart need one, even just a year.', dates, album((id) => `/edit/album/${id}`)),
    group('genres', 'Albums with no genres', 'Without one they are left out of genre pages, the genre map and genre filters.', genres, album((id) => `/edit/album/${id}`)),
    group(
      'spotify',
      'Not found on Spotify',
      'No Spotify album is linked, so “Listen on Spotify” searches instead, and playlists may miss its tracks. The nightly search tries again.',
      spotify,
      album((id) => `/album/${id}`),
    ),
    group('births', 'People with no birthday', 'Birthdays bring their music up on the home page on the day.', births, album((id) => `/edit/artist/${id}`)),
    group('kinds', 'Artists of no known kind', 'Person, band, duo, choir: it decides whether a birthday or a founding date is asked for.', kinds, album((id) => `/edit/artist/${id}`)),
  ].filter((g) => g.total > 0);
}
