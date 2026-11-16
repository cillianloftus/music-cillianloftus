/**
 * Data for the track and genre pages. Scores come from the views; genres
 * from the same tag rules as everywhere (manual tags win; a track without
 * its own inherits its album's).
 */

import { artistRank } from './artist-rank';
import { env } from 'cloudflare:workers';
import { artistLines, releaseGroupsByIds, type CreditPart, type ReleaseGroupSummary } from './catalogue';
import { genreEdges, genreIndex, membersOf, recordingsInGenres, subtreeOf, trackCountsByGenre } from './genres';
import { albumScores } from './album-scores';
import { byDay, byLibrary } from './library-cache';
import type { CreditRole } from './import/plan';

export interface TrackDetail {
  id: string;
  title: string;
  length_ms: number | null;
  isrc: string | null;
  spotify_id: string | null;
  genius_url: string | null;
  mbid: string | null;
  work_id: string | null;
  work_title: string | null;
  quality_score: number | null;
  personal_score: number | null;
  depth: 'gut' | 'detailed' | null;
  /** From Deezer (migration 0054). */
  bpm: number | null;
  loudness: number | null;
  explicit: 0 | 1 | null;
  /** From ListenBrainz: everyone's listens, and how many people. */
  listen_count: number | null;
  listener_count: number | null;
  /** From MusicBrainz (migration 0055). */
  is_cover: 0 | 1 | null;
  is_live: 0 | 1 | null;
  is_instrumental: 0 | 1 | null;
  mb_rating: number | null;
  mb_rating_votes: number | null;
  credits: CreditPart[];
}

export async function trackDetail(id: string, viewerId: string | null): Promise<TrackDetail | null> {
  const row = await env.DB.prepare(
    `SELECT r.id, r.title, r.length_ms, r.isrc, r.spotify_id, r.work_id, w.title AS work_title, r.genius_url, r.mbid,
            r.bpm, r.loudness, r.explicit, r.listen_count, r.listener_count,
            r.is_cover, r.is_live, r.is_instrumental, r.mb_rating, r.mb_rating_votes,
            s.quality_score, s.personal_score, s.depth
     FROM recording r
     LEFT JOIN work w ON w.id = r.work_id
     LEFT JOIN v_recording_score s ON s.recording_id = r.id AND s.user_id = ?2
     WHERE r.id = ?1`,
  )
    .bind(id, viewerId)
    .first<Omit<TrackDetail, 'credits'>>();
  if (!row) return null;
  const lines = await artistLines('recording', [id]);
  return { ...row, credits: lines.get(id) ?? [] };
}

export interface Appearance {
  album: ReleaseGroupSummary;
  /** Where it sits on that album's standard edition, if it is on it. */
  position: number | null;
  disc: number | null;
  standard: boolean;
  /**
   * Not on the standard edition: the edition it is on, named ("The Extended
   * Cut"), with its place there. "Appears on Vanisher, Horizon Scraper" for
   * a bonus track of the Extended Cut alone was misleading (Melissa, 15 Nov).
   */
  edition: { id: string; name: string; position: number | null; disc: number | null } | null;
}

/** Every release the recording is on, earliest first. */
export async function trackAppearances(id: string, viewerId: string | null): Promise<Appearance[]> {
  const { results } = await env.DB.prepare(
    `SELECT x.release_group_id AS album_id,
            max(x.id = c.release_id) AS standard,
            min(CASE WHEN x.id = c.release_id THEN t.position END) AS position,
            min(CASE WHEN x.id = c.release_id THEN t.disc END) AS disc
     FROM track t
     JOIN release x ON x.id = t.release_id
     JOIN v_release_group_canonical c ON c.release_group_id = x.release_group_id
     JOIN release_group g ON g.id = x.release_group_id
     WHERE t.recording_id = ?
     GROUP BY x.release_group_id
     -- In the order they came out: the first release first.
     ORDER BY g.first_release_date IS NULL, substr(g.first_release_date || '-99-99', 1, 10), g.type <> 'album', g.title`,
  )
    .bind(id)
    .all<{ album_id: string; standard: number; position: number | null; disc: number | null }>();
  const [summaries, others] = await Promise.all([
    releaseGroupsByIds(results.map((r) => r.album_id), viewerId),
    // The editions it is on, for the albums whose standard edition it is not on.
    results.some((r) => r.standard !== 1)
      ? env.DB.prepare(
          `SELECT x.release_group_id AS album_id, x.id, x.title, x.note, x.format, substr(x.date, 1, 4) AS year, t.position, t.disc
           FROM track t JOIN release x ON x.id = t.release_id
           WHERE t.recording_id = ?
           -- One with a name of its own first, then the earliest.
           ORDER BY x.note IS NULL, x.date IS NULL, x.date`,
        )
          .bind(id)
          .all<{ album_id: string; id: string; title: string; note: string | null; format: string | null; year: string | null; position: number | null; disc: number | null }>()
          .then((r) => r.results)
      : Promise.resolve([]),
  ]);
  const albums = new Map(summaries.map((a) => [a.id, a]));
  return results.flatMap((r) => {
    const album = albums.get(r.album_id);
    if (!album) return [];
    const on = r.standard === 1 ? undefined : others.find((e) => e.album_id === r.album_id);
    // Its name: MusicBrainz's word for it, else its own title when not the album's, else format and year.
    const name = on ? on.note || (on.title !== album.title ? on.title : null) || [on.format, on.year].filter(Boolean).join(' · ') || 'Another edition' : null;
    return [{ album, position: r.position, disc: r.disc, standard: r.standard === 1, edition: on && name ? { id: on.id, name, position: on.position, disc: on.disc } : null }];
  });
}

export interface TrackCredit {
  artist_id: string;
  name: string;
  role: CreditRole;
  role_label: string;
  family: string;
  key_order: number | null;
}

/** Everyone credited on the recording beyond its artist line, in role order. */
export async function trackCredits(id: string): Promise<TrackCredit[]> {
  const { results } = await env.DB.prepare(
    `SELECT a.id AS artist_id, a.name, c.role, r.label AS role_label, r.family, r.key_order
     FROM artist_credit c JOIN artist a ON a.id = c.artist_id JOIN credit_role r ON r.id = c.role
     WHERE c.entity_type = 'recording' AND c.entity_id = ? AND c.role NOT IN ('primary', 'featured')
     ORDER BY r.key_order IS NULL, r.key_order, r.position, r.label, c.position, a.sort_name`,
  )
    .bind(id)
    .all<TrackCredit>();
  return results;
}

export interface Version {
  id: string;
  title: string;
  album_id: string | null;
  album_title: string | null;
  art_key: string | null;
  quality_score: number | null;
  personal_score: number | null;
  year: string | null;
  credits: CreditPart[];
}

/** Other recordings of the same song (the same work): covers, live takes, remixes. */
export async function otherVersions(id: string, workId: string | null, viewerId: string | null): Promise<Version[]> {
  if (!workId) return [];
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.title, ra.release_group_id AS album_id, g.title AS album_title, coalesce(fa.art_key, x.art_key) AS art_key,
            s.quality_score, s.personal_score, substr(coalesce(r.first_release_date, g.first_release_date), 1, 4) AS year
     FROM recording r
     LEFT JOIN v_recording_first_art fa ON fa.recording_id = r.id
     LEFT JOIN v_recording_album ra ON ra.recording_id = r.id
     LEFT JOIN release_group g ON g.id = ra.release_group_id
     LEFT JOIN v_release_group_canonical gc ON gc.release_group_id = g.id
     LEFT JOIN release x ON x.id = gc.release_id
     LEFT JOIN v_recording_score s ON s.recording_id = r.id AND s.user_id = ?3
     WHERE r.work_id = ?2 AND r.id <> ?1
     ORDER BY s.personal_score IS NULL, s.personal_score DESC, r.title`,
  )
    .bind(id, workId, viewerId)
    .all<Omit<Version, 'credits'>>();
  const lines = await artistLines('recording', results.map((r) => r.id));
  return results.map((r) => ({ ...r, credits: lines.get(r.id) ?? [] }));
}

export interface GenreDetail {
  id: string;
  name: string;
  /** Along primary parents, root first. */
  ancestors: { id: string; name: string }[];
  /** Every parent, the primary one first. */
  parents: { id: string; name: string; primary: boolean }[];
  children: { id: string; name: string; tracks: number }[];
  /** Tracks tagged with this genre itself, or with anything beneath it too when deep. */
  tracks: number;
  albums: number;
  /** The same, always counting everything beneath it. */
  tracksBeneath: number;
  /** Tagged with this genre itself, not one beneath it. */
  tracksDirect: number;
}

/**
 * The genre and, when deep, everything beneath it. A genre on its own is
 * what was tagged with it: an art pop song is not thereby a pop song.
 */
const treeOf = (deep: boolean) =>
  deep
    ? `WITH RECURSIVE tree(id) AS (SELECT ?1 UNION SELECT e.genre_id FROM v_genre_edge e JOIN tree ON e.parent_id = tree.id)`
    : `WITH tree(id) AS (SELECT ?1)`;

export async function genreDetail(id: string, deep = false): Promise<GenreDetail | null> {
  const genre = await env.DB.prepare(`SELECT id, name FROM genre WHERE id = ?`).bind(id).first<{ id: string; name: string }>();
  if (!genre) return null;
  const [ancestors, children, parents] = await env.DB.batch([
    env.DB.prepare(
      `WITH RECURSIVE up(id, name, parent_id, depth) AS (
         SELECT g.id, g.name, g.parent_id, 0 FROM genre g WHERE g.id = (SELECT parent_id FROM genre WHERE id = ?1)
         UNION ALL
         SELECT g.id, g.name, g.parent_id, up.depth + 1 FROM genre g JOIN up ON g.id = up.parent_id
       )
       SELECT id, name FROM up ORDER BY depth DESC`,
    ).bind(id),
    env.DB.prepare(`SELECT g.id, g.name FROM v_genre_edge e JOIN genre g ON g.id = e.genre_id WHERE e.parent_id = ?`).bind(id),
    env.DB.prepare(
      `SELECT g.id, g.name, e.is_primary AS "primary" FROM v_genre_edge e JOIN genre g ON g.id = e.parent_id
       WHERE e.genre_id = ? ORDER BY e.is_primary DESC, g.name`,
    ).bind(id),
  ]);
  // How much is in it, from the genre index (the library's, kept until it
  // changes): its own tracks and albums, or its whole subtree's. Counted in
  // SQL, a big genre's subtree read 42,000 rows.
  const [index, edges] = await Promise.all([genreIndex(), genreEdges()]);
  const below = subtreeOf(id, edges);
  const tree = deep ? below : [id];
  const count = {
    tracks: membersOf(index.tracks, tree).size,
    albums: membersOf(index.albums, tree).size,
    tracksBeneath: membersOf(index.tracks, below).size,
  };
  const trackCounts = Object.fromEntries(Object.entries(index.tracks).map(([g, ids]) => [g, ids.length]));
  const childRows = (children!.results as { id: string; name: string }[])
    .map((c) => ({ ...c, tracks: trackCounts[c.id] ?? 0 }))
    .sort((a, b) => b.tracks - a.tracks || a.name.localeCompare(b.name));
  return {
    ...genre,
    ancestors: ancestors!.results as { id: string; name: string }[],
    children: childRows,
    parents: (parents!.results as { id: string; name: string; primary: number }[]).map((p) => ({ ...p, primary: p.primary === 1 })),
    tracks: count.tracks,
    albums: count.albums,
    tracksBeneath: count.tracksBeneath,
    tracksDirect: trackCounts[id] ?? 0,
  };
}

/** Albums in the genre (or beneath it, when deep): rated ones by score first, then the rest by date. */
export async function genreAlbums(id: string, viewerId: string | null, limit = 24, deep = false): Promise<ReleaseGroupSummary[]> {
  const [{ results }, scores] = await Promise.all([
    env.DB.prepare(
      `${treeOf(deep)}
       SELECT DISTINCT vg.release_group_id AS id, g.first_release_date
       FROM v_release_group_genre vg
       JOIN release_group g ON g.id = vg.release_group_id
       WHERE vg.genre_id IN (SELECT id FROM tree)
       ORDER BY g.first_release_date DESC`,
    )
      .bind(id)
      .all<{ id: string }>(),
    albumScores(viewerId),
  ]);
  // Rated ones by rank first (album-scores.ts); the rest stay newest first (a stable sort).
  const score = (i: string) => scores[i]?.rank ?? null;
  const ids = results
    .map((r) => r.id)
    .sort((a, b) => (score(a) === null ? 1 : 0) - (score(b) === null ? 1 : 0) || (score(b) ?? 0) - (score(a) ?? 0))
    .slice(0, limit);
  const byId = new Map((await releaseGroupsByIds(ids, viewerId)).map((a) => [a.id, a]));
  return ids.map((i) => byId.get(i)).filter((a): a is ReleaseGroupSummary => a !== undefined);
}

/** The best-rated tracks in the genre (or beneath it, when deep). */
export async function genreTopTracks(id: string, viewerId: string | null, limit = 10, deep = false): Promise<string[]> {
  const rated = await ratedInGenre(id, viewerId, deep);
  return rated
    .sort((a, b) => b.personal - a.personal)
    .slice(0, limit)
    .map((r) => r.id);
}

/**
 * The viewer's rated tracks in a genre (or its subtree), with their scores:
 * the genre's tracks from the genre index, met with the viewer's scores in
 * code. Through the genre's tag rows in SQL, a big genre cost 13,000 rows
 * for its top tracks and 19,000 for its artists.
 */
async function ratedInGenre(id: string, viewerId: string | null, deep: boolean): Promise<{ id: string; quality: number; personal: number }[]> {
  if (!viewerId) return [];
  const [index, edges, { results: scored }] = await Promise.all([
    genreIndex(),
    deep ? genreEdges() : Promise.resolve([]),
    env.DB.prepare(`SELECT recording_id AS id, quality_score AS quality, personal_score AS personal FROM v_recording_own_score WHERE user_id = ?`)
      .bind(viewerId)
      .all<{ id: string; quality: number; personal: number }>(),
  ]);
  const inGenre = membersOf(index.tracks, deep ? subtreeOf(id, edges) : [id]);
  return scored.filter((s) => inGenre.has(s.id));
}

export interface GenreArtist {
  id: string;
  name: string;
  image_key: string | null;
  average: number;
  rated: number;
}

/**
 * The artists rated highest in a genre: those with two or more rated tracks
 * in it, ranked by their average there as sure as its number of ratings
 * makes it, against the genre's own average (artist-rank.ts), so a single
 * great track does not top the list. The average shown is the artist's own.
 */
export async function genreArtists(id: string, viewerId: string | null, limit = 8, deep = false): Promise<GenreArtist[]> {
  const rated = await ratedInGenre(id, viewerId, deep);
  if (rated.length === 0) return [];
  const { results } = await env.DB.prepare(
    `WITH rated AS (
       SELECT j.value ->> '$.id' AS recording_id, j.value ->> '$.quality' AS quality_score FROM json_each(?1) j
     ),
     scored AS (
       SELECT c.artist_id, avg(r.quality_score) AS average, count(*) AS rated
       FROM rated r JOIN artist_credit c ON c.entity_type = 'recording' AND c.entity_id = r.recording_id AND c.role = 'primary'
       GROUP BY c.artist_id HAVING count(*) >= 2
     )
     SELECT a.id, a.name, a.sort_name, sc.average, sc.rated, norm.mean
     FROM scored sc JOIN artist a ON a.id = sc.artist_id
     CROSS JOIN (SELECT avg(quality_score) AS mean FROM rated) norm`,
  )
    .bind(JSON.stringify(rated))
    .all<Omit<GenreArtist, 'image_key'> & { sort_name: string; mean: number }>();
  const top = results
    .map((r) => ({ ...r, rank: artistRank(r.average, r.rated, r.mean) }))
    .sort((a, b) => b.rank - a.rank || b.rated - a.rated || a.sort_name.localeCompare(b.sort_name))
    .slice(0, limit);
  return withImages(top.map(({ id, name, average, rated }) => ({ id, name, average, rated })));
}

/** Each artist's first picture, looked up for the few shown. */
async function withImages<T extends { id: string }>(artists: T[]): Promise<(T & { image_key: string | null })[]> {
  if (artists.length === 0) return [];
  const { results } = await env.DB.prepare(
    `SELECT j.value AS id,
            (SELECT i.key FROM artist_image i WHERE i.artist_id = j.value AND i.hidden = 0 ORDER BY i.position, i.key LIMIT 1) AS image_key
     FROM json_each(?) j`,
  )
    .bind(JSON.stringify(artists.map((a) => a.id)))
    .all<{ id: string; image_key: string | null }>();
  const images = new Map(results.map((r) => [r.id, r.image_key]));
  return artists.map((a) => ({ ...a, image_key: images.get(a.id) ?? null }));
}

/**
 * Albums in the library most like this one: shared genres (by weight),
 * and the same main artist counting for more. For "More like this".
 */
interface AlbumProfiles {
  /** album → genre → weight, as v_release_group_genre has them. */
  genres: Record<string, Record<string, number>>;
  /** album → its primary artists. */
  artists: Record<string, string[]>;
}

/**
 * Every album's genres and main artists, once a day. Joined per album page,
 * v_release_group_genre was built whole each time: 14,000 rows a page.
 */
function albumProfiles(): Promise<AlbumProfiles> {
  return byDay('album-profiles:v1', async () => {
    const [genres, artists] = await env.DB.batch([
      env.DB.prepare(`SELECT release_group_id AS id, genre_id AS g, weight AS w FROM v_release_group_genre`),
      env.DB.prepare(`SELECT entity_id AS id, artist_id AS a FROM artist_credit WHERE entity_type = 'release_group' AND role = 'primary'`),
    ]);
    const profiles: AlbumProfiles = { genres: {}, artists: {} };
    for (const r of genres!.results as { id: string; g: string; w: number }[]) (profiles.genres[r.id] ??= {})[r.g] = r.w;
    for (const r of artists!.results as { id: string; a: string }[]) (profiles.artists[r.id] ??= []).push(r.a);
    return profiles;
  });
}

/**
 * Albums most like this one, by the same rule as before: for each shared
 * genre the smaller of the two weights, plus 1.5 for the same main artist.
 * Pure, over the profiles.
 */
export function rankSimilar(id: string, profiles: AlbumProfiles, limit: number): string[] {
  const mine = profiles.genres[id] ?? {};
  const myArtists = new Set(profiles.artists[id] ?? []);
  const scores = new Map<string, number>();
  for (const [other, theirs] of Object.entries(profiles.genres)) {
    if (other === id) continue;
    let s = 0;
    for (const [g, w] of Object.entries(theirs)) if (mine[g] !== undefined) s += Math.min(w, mine[g]!);
    if (s > 0) scores.set(other, s);
  }
  for (const [other, artists] of Object.entries(profiles.artists)) {
    if (other !== id && artists.some((a) => myArtists.has(a))) scores.set(other, (scores.get(other) ?? 0) + 1.5);
  }
  return [...scores]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, limit)
    .map(([other]) => other);
}

export async function similarAlbums(id: string, viewerId: string | null, limit = 8): Promise<ReleaseGroupSummary[]> {
  const ids = rankSimilar(id, await albumProfiles(), limit);
  const byId = new Map((await releaseGroupsByIds(ids, viewerId)).map((a) => [a.id, a]));
  return ids.map((i) => byId.get(i)).filter((a): a is ReleaseGroupSummary => a !== undefined);
}
