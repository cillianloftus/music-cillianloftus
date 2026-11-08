/**
 * Reads what a recap needs: the range's listens, the catalogue's names,
 * genres and scores for those it has, and which songs and artists were
 * heard before the range began. Every lookup is a separate, plain
 * statement (D1 refuses one statement that expands too many views).
 */

import { env } from 'cloudflare:workers';
import { byLibrary } from '../library-cache';
import { MIN_COUNTED_MS } from '../listens/dedupe';
import { normaliseTitle } from '../text';
import { buildRecap, type Recap, type RecapListen, type RecapSkip } from './build';
import { parseRange, type Range } from './range';

/** When nothing says how long a listen was, nor the track's length. */
const TYPICAL_MS = 210_000;

interface PlayRow {
  played_at: string;
  ms_played: number | null;
  source: string;
  counted: number;
  duplicate: number;
  skipped: number | null;
  shuffle: number | null;
  platform: string | null;
  recording_id: string | null;
  artist: string;
  title: string;
  album: string | null;
  artist_key: string;
  title_key: string;
}

export interface SongName {
  title: string;
  artist: string;
  artistId: string | null;
  recordingId: string | null;
  albumId: string | null;
  art: string | null;
}

export interface RecapView {
  range: Range;
  recap: Recap;
  previous: { plays: number; minutes: number; songs: number; artists: number } | null;
  songs: Record<string, SongName>;
  artists: Record<string, { name: string; id: string | null; art: string | null }>;
  albums: Record<string, { title: string; artist: string; id: string | null; art: string | null }>;
  genres: Record<string, { name: string }>;
}

const json = (v: unknown) => JSON.stringify(v);
const bool = (v: number | null) => (v === null ? null : v === 1);

async function playsIn(userId: string, range: Range): Promise<PlayRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.played_at, p.ms_played, p.source, p.counted, p.duplicate_of IS NOT NULL AS duplicate,
            p.skipped, p.shuffle, p.platform, p.recording_id,
            t.artist, t.title, t.album, t.artist_key, t.title_key
     FROM play p JOIN listen_track t ON t.key = p.track_key
     WHERE p.user_id = ?1 AND p.played_at >= ?2 AND p.played_at < ?3`,
  )
    .bind(userId, range.start, range.end)
    .all<PlayRow>();
  return results;
}

interface Catalogue {
  recordings: Map<string, { title: string; length_ms: number | null; album_id: string | null; album_title: string | null }>;
  artists: Map<string, { id: string; name: string }>;
  genres: Map<string, string[]>;
  genreNames: Map<string, string>;
  scores: Map<string, number>;
  art: Map<string, string>;
}

interface TagRow {
  id: string;
  genre_id: string;
  source: string;
  name: string;
}

/** Genres per entity from its tags; hand-set tags, where there are any, replace the rest (as the genre views do). */
function ownGenres(rows: TagRow[], names: Map<string, string>): Map<string, string[]> {
  const manual = new Set(rows.filter((r) => r.source === 'manual').map((r) => r.id));
  const out = new Map<string, string[]>();
  for (const r of rows) {
    if (manual.has(r.id) && r.source !== 'manual') continue;
    const list = out.get(r.id) ?? [];
    if (!list.includes(r.genre_id)) list.push(r.genre_id);
    out.set(r.id, list);
    names.set(r.genre_id, r.name);
  }
  return out;
}

async function catalogueFor(userId: string, ids: string[]): Promise<Catalogue> {
  const list = json(ids);
  const [recordings, artists, genres, scores] = await env.DB.batch([
    env.DB.prepare(
      `SELECT r.id, r.title, r.length_ms, ra.release_group_id AS album_id, g.title AS album_title
       FROM recording r
       LEFT JOIN v_recording_album ra ON ra.recording_id = r.id
       LEFT JOIN release_group g ON g.id = ra.release_group_id
       WHERE r.id IN (SELECT value FROM json_each(?1))`,
    ).bind(list),
    env.DB.prepare(
      `SELECT c.entity_id AS recording_id, a.id, a.name
       FROM artist_credit c JOIN artist a ON a.id = c.artist_id
       WHERE c.entity_type = 'recording' AND c.role = 'primary' AND c.entity_id IN (SELECT value FROM json_each(?1))
       ORDER BY c.entity_id, c.position`,
    ).bind(list),
    // Tags read directly: through v_recording_genre one track read 72,000 rows.
    env.DB.prepare(
      `SELECT t.entity_id AS id, t.genre_id, t.source, g.name FROM genre_tag t JOIN genre g ON g.id = t.genre_id
       WHERE t.entity_type = 'recording' AND t.entity_id IN (SELECT value FROM json_each(?1))`,
    ).bind(list),
    env.DB.prepare(
      `SELECT recording_id, quality_score FROM v_recording_score
       WHERE user_id = ?1 AND recording_id IN (SELECT value FROM json_each(?2))`,
    ).bind(userId, list),
  ]);
  const out: Catalogue = { recordings: new Map(), artists: new Map(), genres: new Map(), genreNames: new Map(), scores: new Map(), art: new Map() };
  for (const r of recordings!.results as { id: string; title: string; length_ms: number | null; album_id: string | null; album_title: string | null }[]) out.recordings.set(r.id, r);
  for (const a of artists!.results as { recording_id: string; id: string; name: string }[]) if (!out.artists.has(a.recording_id)) out.artists.set(a.recording_id, a);
  const own = ownGenres(genres!.results as TagRow[], out.genreNames);
  for (const s of scores!.results as { recording_id: string; quality_score: number }[]) out.scores.set(s.recording_id, s.quality_score);

  const albumIds = [...new Set([...out.recordings.values()].map((r) => r.album_id).filter((id): id is string => id !== null))];
  let albumGenres = new Map<string, string[]>();
  if (albumIds.length) {
    const [art, tags] = await env.DB.batch([
      env.DB.prepare(
        `SELECT c.release_group_id AS id, r.art_key FROM v_release_group_canonical c JOIN release r ON r.id = c.release_id
         WHERE c.release_group_id IN (SELECT value FROM json_each(?1)) AND r.art_key IS NOT NULL`,
      ).bind(json(albumIds)),
      env.DB.prepare(
        `SELECT t.entity_id AS id, t.genre_id, t.source, g.name FROM genre_tag t JOIN genre g ON g.id = t.genre_id
         WHERE t.entity_type = 'release_group' AND t.entity_id IN (SELECT value FROM json_each(?1))`,
      ).bind(json(albumIds)),
    ]);
    for (const r of art!.results as { id: string; art_key: string }[]) out.art.set(r.id, r.art_key);
    albumGenres = ownGenres(tags!.results as TagRow[], out.genreNames);
  }
  // A track's own genres, else its album's: as v_recording_genre has it.
  for (const [id, rec] of out.recordings) {
    const genres = own.get(id) ?? (rec.album_id ? albumGenres.get(rec.album_id) : undefined);
    if (genres?.length) out.genres.set(id, genres);
  }
  return out;
}

/** Of the given songs and artists, those heard (and counted) before an instant. */
async function heardBefore(userId: string, before: string, songs: { a: string; t: string }[], artists: string[]) {
  const [s, a] = await env.DB.batch([
    env.DB.prepare(
      `SELECT j.value ->> '$.a' AS a, j.value ->> '$.t' AS t FROM json_each(?2) j
       WHERE EXISTS (SELECT 1 FROM listen_track lt JOIN play p ON p.track_key = lt.key
                     WHERE lt.artist_key = j.value ->> '$.a' AND lt.title_key = j.value ->> '$.t'
                       AND p.user_id = ?1 AND p.played_at < ?3 AND p.counted = 1)`,
    ).bind(userId, json(songs), before),
    env.DB.prepare(
      `SELECT j.value AS a FROM json_each(?2) j
       WHERE EXISTS (SELECT 1 FROM listen_track lt JOIN play p ON p.track_key = lt.key
                     WHERE lt.artist_key = j.value AND p.user_id = ?1 AND p.played_at < ?3 AND p.counted = 1)`,
    ).bind(userId, json(artists), before),
  ]);
  return {
    songs: new Set((s!.results as { a: string; t: string }[]).map((r) => `${r.a}|${r.t}`)),
    artists: new Set((a!.results as { a: string }[]).map((r) => r.a)),
  };
}

async function totalsIn(userId: string, range: Range) {
  const row = await env.DB.prepare(
    `SELECT count(*) AS plays, coalesce(sum(coalesce(p.ms_played, r.length_ms, ${TYPICAL_MS})), 0) / 60000.0 AS minutes,
            count(DISTINCT t.artist_key || '|' || t.title_key) AS songs, count(DISTINCT t.artist_key) AS artists
     FROM play p JOIN listen_track t ON t.key = p.track_key LEFT JOIN recording r ON r.id = p.recording_id
     WHERE p.user_id = ?1 AND p.counted = 1 AND p.played_at >= ?2 AND p.played_at < ?3`,
  )
    .bind(userId, range.start, range.end)
    .first<{ plays: number; minutes: number; songs: number; artists: number }>();
  return row ?? { plays: 0, minutes: 0, songs: 0, artists: 0 };
}

/** The first and last day with a counted listen, and the months between that have any. */
export async function listeningSpan(userId: string): Promise<{ first: string | null; last: string | null; months: { month: string; plays: number }[] }> {
  return byLibrary('listening-span:v1', userId, async () => {
    const { results } = await env.DB.prepare(
      `SELECT substr(played_at, 1, 7) AS month, count(*) AS plays, min(played_at) AS first, max(played_at) AS last
       FROM play WHERE user_id = ?1 AND counted = 1 GROUP BY month ORDER BY month`,
    )
      .bind(userId)
      .all<{ month: string; plays: number; first: string; last: string }>();
    return {
      first: results[0]?.first.slice(0, 10) ?? null,
      last: results.at(-1)?.last.slice(0, 10) ?? null,
      months: results.map(({ month, plays }) => ({ month, plays })),
    };
  });
}

/** Everything the recap page shows for a range. */
export async function loadRecap(userId: string, range: Range): Promise<RecapView> {
  const rows = await playsIn(userId, range);
  const ids = [...new Set(rows.map((r) => r.recording_id).filter((id): id is string => id !== null))];
  const cat = ids.length ? await catalogueFor(userId, ids) : null;

  // A listen's length: as reported, else the track's, else what is typical here.
  const reported = rows.filter((r) => r.counted && r.ms_played != null).map((r) => r.ms_played!).sort((a, b) => a - b);
  const typical = reported.length >= 20 ? reported[Math.floor(reported.length / 2)]! : TYPICAL_MS;

  const listens: RecapListen[] = [];
  const short: RecapSkip[] = [];
  let duplicates = 0;
  const songs: RecapView['songs'] = {};
  const artists: RecapView['artists'] = {};
  const albums: RecapView['albums'] = {};
  for (const r of rows) {
    const song = `${r.artist_key}|${r.title_key}`;
    if (r.duplicate) {
      duplicates += 1;
      continue;
    }
    const at = Date.parse(r.played_at);
    if (!r.counted) {
      if (r.ms_played != null && r.ms_played < MIN_COUNTED_MS) short.push({ at, song, artist: r.artist_key });
      continue;
    }
    const rec = r.recording_id ? cat?.recordings.get(r.recording_id) : undefined;
    const credit = r.recording_id ? cat?.artists.get(r.recording_id) : undefined;
    const albumKey = rec?.album_id ? `rg:${rec.album_id}` : r.album ? `n:${r.artist_key}|${normaliseTitle(r.album)}` : null;
    const art = rec?.album_id ? (cat?.art.get(rec.album_id) ?? null) : null;
    const ms = r.ms_played ?? rec?.length_ms ?? typical;
    listens.push({
      at,
      ms,
      estimated: r.ms_played == null,
      source: r.source,
      song,
      artist: r.artist_key,
      album: albumKey,
      genres: (r.recording_id && cat?.genres.get(r.recording_id)) || [],
      score: r.recording_id ? (cat?.scores.get(r.recording_id) ?? null) : null,
      recording: r.recording_id,
      skipped: bool(r.skipped),
      shuffle: bool(r.shuffle),
      platform: r.platform,
    });
    // Names: the catalogue's where it has the track, else as the source gave them.
    const known = songs[song];
    if (!known || (!known.recordingId && r.recording_id)) {
      songs[song] = {
        title: rec?.title ?? r.title,
        artist: credit?.name ?? r.artist.split(/\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0]!,
        artistId: credit?.id ?? null,
        recordingId: r.recording_id,
        albumId: rec?.album_id ?? null,
        art,
      };
    }
    if (!artists[r.artist_key] || (!artists[r.artist_key]!.id && credit)) {
      artists[r.artist_key] = { name: credit?.name ?? songs[song]!.artist, id: credit?.id ?? null, art: artists[r.artist_key]?.art ?? art };
    } else if (!artists[r.artist_key]!.art && art) {
      artists[r.artist_key]!.art = art;
    }
    if (albumKey && !albums[albumKey]) {
      albums[albumKey] = { title: rec?.album_title ?? r.album!, artist: songs[song]!.artist, id: rec?.album_id ?? null, art };
    }
  }

  let known: { songs: Set<string>; artists: Set<string> } | null = null;
  if (range.kind !== 'all' && listens.length) {
    const songKeys = [...new Set(listens.map((l) => l.song))].map((k) => {
      const [a, t] = k.split('|') as [string, string];
      return { a, t };
    });
    known = await heardBefore(userId, range.start, songKeys, [...new Set(listens.map((l) => l.artist))]);
  }

  const recap = buildRecap({
    listens,
    short,
    knownSongs: known?.songs ?? null,
    knownArtists: known?.artists ?? null,
    from: range.from,
    to: range.to,
    duplicates,
  });
  const previous = range.previous ? await totalsIn(userId, range.previous) : null;
  const genres: RecapView['genres'] = {};
  for (const g of recap.genres) genres[g.key] = { name: cat?.genreNames.get(g.key) ?? g.key };
  return { range, recap, previous, songs, artists, albums, genres };
}

/** A recap, kept until the library or the listening changes. Rolling ranges key on their days, so they turn over at midnight. */
export async function recapFor(userId: string, slug: string | undefined, now = Date.now()): Promise<RecapView | null> {
  const span = await listeningSpan(userId);
  const range = parseRange(slug, now, span.first);
  if (!range) return null;
  return byLibrary(`recap:v2:${range.slug}:${range.from}:${range.to}`, userId, () => loadRecap(userId, range));
}
