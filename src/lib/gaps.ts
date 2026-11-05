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

const RATED_FIRST = `EXISTS (SELECT 1 FROM rating x WHERE (x.entity_type = 'release_group' AND x.entity_id = g.id)
                       OR (x.entity_type = 'recording' AND x.entity_id IN (
                             SELECT t.recording_id FROM release rr JOIN track t ON t.release_id = rr.id WHERE rr.release_group_id = g.id))) DESC`;

const albumArtist = `(SELECT group_concat(a.name, ', ') FROM artist_credit c JOIN artist a ON a.id = c.artist_id
                      WHERE c.entity_type = 'release_group' AND c.entity_id = g.id AND c.role = 'primary')`;

export async function missingInfo(): Promise<GapGroup[]> {
  const page = (sql: string) => env.DB.prepare(`SELECT count(*) OVER () AS total, * FROM (${sql}) LIMIT ${SHOWN}`);
  const [writers, dates, genres, spotify, births, kinds] = await env.DB.batch([
    page(
      `SELECT g.id, g.title, ${albumArtist} AS artist, count(*) AS n, sum(count(*)) OVER () AS tracks
       FROM release_group g
       JOIN v_release_group_canonical c ON c.release_group_id = g.id
       JOIN track t ON t.release_id = c.release_id
       WHERE NOT EXISTS (SELECT 1 FROM artist_credit w WHERE w.entity_type = 'recording' AND w.entity_id = t.recording_id AND w.role IN (SELECT id FROM credit_role WHERE family = 'writing'))
       GROUP BY g.id
       ORDER BY ${RATED_FIRST}, n DESC, g.title`,
    ),
    page(
      `SELECT g.id, g.title, ${albumArtist} AS artist FROM release_group g
       WHERE g.first_release_date IS NULL AND g.status = 'released'
       ORDER BY ${RATED_FIRST}, g.title`,
    ),
    page(
      `SELECT g.id, g.title, ${albumArtist} AS artist FROM release_group g
       WHERE NOT EXISTS (SELECT 1 FROM genre_tag t WHERE t.entity_type = 'release_group' AND t.entity_id = g.id)
       ORDER BY ${RATED_FIRST}, g.title`,
    ),
    page(
      `SELECT g.id, g.title, ${albumArtist} AS artist FROM release_group g
       WHERE g.spotify_id IS NULL AND g.status = 'released' AND coalesce(g.availability, '') <> 'unreleased'
       ORDER BY ${RATED_FIRST}, g.title`,
    ),
    page(
      `SELECT a.id, a.name AS title, NULL AS artist FROM artist a
       WHERE a.kind = 'person' AND a.begin_date IS NULL
       ORDER BY (SELECT count(*) FROM artist_credit c WHERE c.artist_id = a.id AND c.role = 'primary') DESC, a.sort_name`,
    ),
    page(
      `SELECT a.id, a.name AS title, NULL AS artist FROM artist a
       WHERE a.kind IS NULL
         AND EXISTS (SELECT 1 FROM artist_credit c WHERE c.artist_id = a.id AND c.role = 'primary')
       ORDER BY (SELECT count(*) FROM artist_credit c WHERE c.artist_id = a.id AND c.role = 'primary') DESC, a.sort_name`,
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
