/**
 * Finds albums on Spotify by themselves, so "Listen on Spotify" goes to
 * the album rather than a search. An album is accepted only when its
 * title (edition words aside) and its first artist both match, and it is
 * not a compilation; ties go to the release date nearest ours. Then its
 * tracks are matched by disc, position and title to the standard edition.
 *
 * Fills empty ids only, and never one another row already holds.
 */

import { env } from 'cloudflare:workers';
import { normaliseName, normaliseTitle } from '../text';
import { MARKET, type SpotifyClient } from './client';

interface SpotifyAlbumHit {
  id: string;
  name: string;
  album_type: string;
  release_date: string;
  total_tracks: number;
  artists: { name: string }[];
}

interface Album {
  id: string;
  title: string;
  first_release_date: string | null;
  artist: string | null;
  release_id: string | null;
  track_count: number;
}

const term = (value: string) => value.replace(/["':]/g, ' ').replace(/\s+/g, ' ').trim();

/** The best confident match among search results, or null. Pure. */
export function pickAlbum(album: Pick<Album, 'title' | 'artist' | 'first_release_date' | 'track_count'>, hits: SpotifyAlbumHit[]): SpotifyAlbumHit | null {
  if (!album.artist) return null;
  const title = normaliseTitle(album.title);
  const artist = normaliseName(album.artist);
  const year = album.first_release_date ? Number(album.first_release_date.slice(0, 4)) : null;
  const ok = hits.filter(
    (h) => h.album_type !== 'compilation' && normaliseTitle(h.name) === title && h.artists.some((a) => normaliseName(a.name) === artist),
  );
  if (ok.length === 0) return null;
  // Nearest year first, then the edition closest in length (the standard one, not a deluxe).
  const distance = (h: SpotifyAlbumHit) =>
    (year ? Math.abs(Number(h.release_date.slice(0, 4)) - year) * 100 : 0) + Math.abs(h.total_tracks - album.track_count);
  return [...ok].sort((a, b) => distance(a) - distance(b))[0]!;
}

async function albumsToLink(limit: number, only?: string): Promise<Album[]> {
  // One album (straight after its import) is a seek on its id; "?2 IS NULL
  // OR g.id = ?2" in one statement read every album, about 2,200 rows an import.
  const which = only ? 'g.id = ?2' : '?2 IS NULL';
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.title, g.first_release_date, c.release_id,
            (SELECT a.name FROM artist_credit ac JOIN artist a ON a.id = ac.artist_id
             WHERE ac.entity_type = 'release_group' AND ac.entity_id = g.id AND ac.role = 'primary'
             ORDER BY ac.position LIMIT 1) AS artist,
            (SELECT count(*) FROM track t WHERE t.release_id = c.release_id) AS track_count
     FROM release_group g
     LEFT JOIN v_release_group_canonical c ON c.release_group_id = g.id
     WHERE g.spotify_id IS NULL AND g.status = 'released' AND ${which}
         AND NOT EXISTS (SELECT 1 FROM field_override fo WHERE fo.entity_type = 'release_group' AND fo.entity_id = g.id AND fo.field = 'spotify_id')
     ORDER BY g.created_at DESC
     LIMIT ?1`,
  )
    .bind(limit, only ?? null)
    .all<Album>();
  return results;
}

/** Matches the album's tracks to its standard edition and fills their ids. */
async function linkTracks(spotify: SpotifyClient, album: Album, spotifyAlbumId: string): Promise<number> {
  if (!album.release_id) return 0;
  const page = await spotify.get<{ items: { id: string; name: string; disc_number: number; track_number: number }[] }>(
    `/albums/${spotifyAlbumId}/tracks?limit=50&market=${MARKET}`,
  );
  const ours = (
    await env.DB.prepare(
      `SELECT t.disc, t.position, r.id, r.title, r.spotify_id FROM track t JOIN recording r ON r.id = t.recording_id WHERE t.release_id = ?`,
    )
      .bind(album.release_id)
      .all<{ disc: number; position: number; id: string; title: string; spotify_id: string | null }>()
  ).results;
  const matches = page.items.flatMap((item) => {
    const mine = ours.find((o) => o.disc === (item.disc_number || 1) && o.position === item.track_number);
    // Position alone is not enough: the titles have to agree too.
    return mine && !mine.spotify_id && normaliseTitle(mine.title) === normaliseTitle(item.name) ? [{ id: mine.id, spotify_id: item.id }] : [];
  });
  if (matches.length === 0) return 0;
  // One keyed update per track, in one batch. A single UPDATE … FROM
  // json_each walked the whole recording table for each track (430,000
  // rows a call); these are index lookups.
  const results = await env.DB.batch(
    matches.map((m) =>
      env.DB.prepare(
        `UPDATE recording SET spotify_id = ?1
         WHERE id = ?2 AND spotify_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM field_override fo WHERE fo.entity_type = 'recording' AND fo.entity_id = ?2 AND fo.field = 'spotify_id')
           AND NOT EXISTS (SELECT 1 FROM recording o WHERE o.spotify_id = ?1)`,
      ).bind(m.spotify_id, m.id),
    ),
  );
  return results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
}

export interface LinkReport {
  albums: number;
  tracks: number;
  missed: string[];
}

/** Links albums without a Spotify id (or just one). Search allows 10 results a request in Development Mode. */
export async function linkAlbumsToSpotify(spotify: SpotifyClient, { limit = 20, only }: { limit?: number; only?: string } = {}): Promise<LinkReport> {
  const report: LinkReport = { albums: 0, tracks: 0, missed: [] };
  for (const album of await albumsToLink(limit, only)) {
    if (!album.artist) continue;
    const params = new URLSearchParams({ q: `album:${term(album.title)} artist:${term(album.artist)}`, type: 'album', limit: '10', market: MARKET });
    const hits = (await spotify.get<{ albums: { items: SpotifyAlbumHit[] } }>(`/search?${params}`)).albums.items;
    const pick = pickAlbum(album, hits);
    if (!pick) {
      report.missed.push(album.title);
      continue;
    }
    const set = await env.DB.prepare(
      `UPDATE release_group SET spotify_id = ?1 WHERE id = ?2 AND spotify_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM field_override fo WHERE fo.entity_type = 'release_group' AND fo.entity_id = ?2 AND fo.field = 'spotify_id')
         AND NOT EXISTS (SELECT 1 FROM release_group o WHERE o.spotify_id = ?1)`,
    )
      .bind(pick.id, album.id)
      .run();
    if (set.meta.changes) report.albums++;
    report.tracks += await linkTracks(spotify, album, pick.id);
  }
  return report;
}

/**
 * One edition of an album, found on Spotify by itself: "Listen" on an
 * edition other than the standard one played the standard album, and an
 * edition with no Spotify id could not be played at all (Vanisher, Horizon
 * Scraper's Extended Cut, 15 Nov). Spotify names such an edition after the
 * album with its words added ("… (The Extended Cut)"), so a hit is the same
 * album by the same artist whose name holds the edition's MusicBrainz note
 * when it has one, else whose track count is the edition's. Never an id
 * another edition or album already holds. Returns the id, kept, or null.
 */
export async function findEditionOnSpotify(spotify: SpotifyClient, releaseId: string): Promise<string | null> {
  const edition = await env.DB.prepare(
    `SELECT r.id, r.spotify_id, r.note, r.release_group_id, g.title,
            (SELECT a.name FROM artist_credit ac JOIN artist a ON a.id = ac.artist_id
             WHERE ac.entity_type = 'release_group' AND ac.entity_id = g.id AND ac.role = 'primary' ORDER BY ac.position LIMIT 1) AS artist,
            (SELECT count(*) FROM track t WHERE t.release_id = r.id) AS track_count
     FROM release r JOIN release_group g ON g.id = r.release_group_id WHERE r.id = ?`,
  )
    .bind(releaseId)
    .first<{ id: string; spotify_id: string | null; note: string | null; release_group_id: string; title: string; artist: string | null; track_count: number }>();
  if (!edition) return null;
  if (edition.spotify_id) return edition.spotify_id;
  if (!edition.artist) return null;

  const { results: taken } = await env.DB.prepare(
    `SELECT spotify_id AS id FROM release WHERE release_group_id = ?1 AND spotify_id IS NOT NULL
     UNION SELECT spotify_id FROM release_group WHERE id = ?1 AND spotify_id IS NOT NULL`,
  )
    .bind(edition.release_group_id)
    .all<{ id: string }>();
  const held = new Set(taken.map((t) => t.id));
  const queries = [edition.note ? `${edition.title} ${edition.note}` : null, edition.title].filter((q): q is string => Boolean(q));
  const artist = normaliseName(edition.artist);
  const album = normaliseTitle(edition.title);
  const note = edition.note ? normaliseTitle(edition.note).replace(/^the\s+/, '') : null;
  for (const q of queries) {
    const params = new URLSearchParams({ q: `album:${term(q)} artist:${term(edition.artist)}`, type: 'album', limit: '10', market: MARKET });
    const hits = (await spotify.get<{ albums: { items: SpotifyAlbumHit[] } }>(`/search?${params}`)).albums.items.filter(
      (h) => !held.has(h.id) && h.artists.some((a) => normaliseName(a.name) === artist) && normaliseTitle(h.name).startsWith(album),
    );
    const pick =
      (note ? hits.find((h) => normaliseTitle(h.name).includes(note)) : undefined) ??
      hits.find((h) => h.total_tracks === edition.track_count);
    if (!pick) continue;
    const set = await env.DB.prepare(
      `UPDATE release SET spotify_id = ?1 WHERE id = ?2 AND spotify_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM release o WHERE o.spotify_id = ?1)`,
    )
      .bind(pick.id, edition.id)
      .run();
    if (!set.meta.changes) return null;
    await linkTracks(spotify, { id: edition.release_group_id, title: edition.title, first_release_date: null, artist: edition.artist, release_id: edition.id, track_count: edition.track_count }, pick.id).catch(() => 0);
    return pick.id;
  }
  return null;
}
