/**
 * Albums from Spotify by link (ARCHITECTURE.md §5, rung 2): fetched by id,
 * which sidesteps Development Mode's ten-result search cap and makes this
 * the practical route for small artists.
 *
 * Endpoints used, all still allowed after Spotify's February 2026 changes:
 * GET /albums/{id}, GET /albums/{id}/tracks, GET /tracks/{id} (for ISRCs,
 * which album track listings omit). Label and popularity were removed from
 * the album object and are not relied on.
 */

import { sortName } from '../import/manual';
import type { ImportPlan, PlanArtist, PlanCredit, PlanRecording, PlanTrack, ReleaseGroupType } from '../import/plan';
import type { DatePrecision } from '../dates';

export interface SpotifyArtistRef {
  id: string;
  name: string;
}

export interface SpotifyTrack {
  id: string;
  name: string;
  disc_number: number;
  track_number: number;
  duration_ms: number;
  artists: SpotifyArtistRef[];
  isrc?: string | null;
}

export interface SpotifyAlbum {
  id: string;
  name: string;
  album_type: 'album' | 'single' | 'compilation';
  release_date: string;
  release_date_precision: 'year' | 'month' | 'day';
  artists: SpotifyArtistRef[];
  images: { url: string; width: number | null; height: number | null }[];
  external_ids?: { upc?: string; ean?: string };
  total_tracks: number;
  tracks: { items: SpotifyTrack[]; next: string | null };
}

export type SpotifyTarget = { kind: 'album' | 'track'; id: string };

const ID = '([A-Za-z0-9]{22})';

/** An open.spotify.com album or track link (any locale prefix), or a spotify: URI. */
export function parseSpotifyInput(input: string): SpotifyTarget | null {
  const value = input.trim();
  const uri = new RegExp(`^spotify:(album|track):${ID}$`).exec(value);
  if (uri) return { kind: uri[1] as 'album' | 'track', id: uri[2]! };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.hostname !== 'open.spotify.com') return null;
  const path = new RegExp(`^/(?:intl-[a-z]{2}(?:-[A-Za-z]{2})?/)?(album|track)/${ID}/?$`).exec(url.pathname);
  return path ? { kind: path[1] as 'album' | 'track', id: path[2]! } : null;
}

export interface Getter {
  get<T>(path: string): Promise<T>;
}

/** The album with every track (pages past the first 50) and each track's ISRC. */
export async function fetchSpotifyAlbum(client: Getter, id: string): Promise<SpotifyAlbum> {
  const album = await client.get<SpotifyAlbum>(`/albums/${id}`);
  const tracks = [...album.tracks.items];
  for (let offset = tracks.length; offset < album.total_tracks && offset < 500; offset += 50) {
    const page = await client.get<{ items: SpotifyTrack[] }>(`/albums/${id}/tracks?limit=50&offset=${offset}`);
    if (page.items.length === 0) break;
    tracks.push(...page.items);
  }
  // Album listings carry no ISRC; one request per track gets it.
  for (const track of tracks) {
    const full = await client.get<{ external_ids?: { isrc?: string } }>(`/tracks/${track.id}`).catch(() => null);
    const isrc = full?.external_ids?.isrc?.replace(/-/g, '').toUpperCase() ?? null;
    track.isrc = isrc && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc) ? isrc : null;
  }
  return { ...album, tracks: { items: tracks, next: null } };
}

export function releaseGroupTypeOf(album: SpotifyAlbum): ReleaseGroupType {
  if (album.album_type === 'compilation') return 'compilation';
  if (album.album_type === 'single') return album.total_tracks >= 4 ? 'ep' : 'single';
  return 'album';
}

/** Spotify pads unknown parts with 01 ("1977-01-01" at year precision): keep only what is known. */
export function spotifyDate(album: SpotifyAlbum): { date: string | null; precision: DatePrecision } {
  const length = { year: 4, month: 7, day: 10 }[album.release_date_precision];
  const date = album.release_date?.slice(0, length) ?? null;
  return date && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(date) && date !== '0000'
    ? { date, precision: album.release_date_precision }
    : { date: null, precision: 'unknown' };
}

export function planFromSpotify(album: SpotifyAlbum): ImportPlan {
  const artists = new Map<string, PlanArtist>();
  const artistKey = (a: SpotifyArtistRef) => {
    const key = `spotify:artist:${a.id}`;
    if (!artists.has(key)) artists.set(key, { key, mbid: null, spotify_id: a.id, name: a.name, sort_name: sortName(a.name), disambiguation: null });
    return key;
  };
  const credits: PlanCredit[] = [];
  const credit = (entity: PlanCredit['entity'], entity_key: string, list: SpotifyArtistRef[], role: PlanCredit['role']) =>
    list.forEach((a, i) =>
      credits.push({
        entity,
        entity_key,
        artist_key: artistKey(a),
        role,
        position: i + 1,
        credited_as: null,
        join_phrase: i === list.length - 1 ? '' : i === list.length - 2 ? ' & ' : ', ',
      }),
    );

  credit('release_group', 'release_group', album.artists, 'primary');
  credit('release', 'release', album.artists, 'primary');

  const { date, precision } = spotifyDate(album);
  const recordings: PlanRecording[] = [];
  const tracks: PlanTrack[] = [];
  const albumArtists = new Set(album.artists.map((a) => a.id));
  for (const t of album.tracks.items) {
    const key = `spotify:track:${t.id}`;
    recordings.push({
      key,
      mbid: null,
      spotify_id: t.id,
      title: t.name,
      length_ms: t.duration_ms > 0 ? t.duration_ms : null,
      first_release_date: null,
      date_precision: 'unknown',
      isrc: t.isrc ?? null,
      work_key: null,
    });
    tracks.push({ recording_key: key, disc: t.disc_number || 1, position: t.track_number, title_on_release: null });
    // Track artists who are album artists lead; anyone else is a guest. On a
    // compilation none are album artists, so the first track artist leads.
    let lead = t.artists.filter((a) => albumArtists.has(a.id));
    let guests = t.artists.filter((a) => !albumArtists.has(a.id));
    if (lead.length === 0) {
      lead = t.artists.slice(0, 1);
      guests = t.artists.slice(1);
    }
    credit('recording', key, lead, 'primary');
    if (guests.length) {
      credits.at(-1)!.join_phrase = ' feat. ';
      credit('recording', key, guests, 'featured');
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  return {
    source: 'spotify',
    artists: [...artists.values()],
    works: [],
    recordings,
    releaseGroup: {
      key: 'release_group',
      mbid: null,
      spotify_id: album.id,
      title: album.name,
      type: releaseGroupTypeOf(album),
      status: date && date > today ? 'announced' : 'released',
      first_release_date: date,
      date_precision: precision,
    },
    release: {
      key: 'release',
      mbid: null,
      spotify_id: album.id,
      title: album.name,
      date,
      date_precision: precision,
      country: null,
      label: null,
      format: 'Digital Media',
    },
    tracks,
    credits,
    releaseGroupGenres: [],
  };
}
