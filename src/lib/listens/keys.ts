/**
 * How a listen's track is named and keyed. Each source names a track its
 * own way: Spotify by track id, ListenBrainz and Last.fm often by
 * MusicBrainz recording id, otherwise by artist and title. The key is the
 * best of these the source gave. The song (artist_key, title_key) is the
 * same whichever source it came from, which is what deduplication and
 * recaps group on.
 */

import { normaliseName, normaliseTitle } from '../text';

/** "feat. X" in brackets or at the end: the song is the same with or without it. */
const FEATURING = /\s*[([](?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]|\s+(?:feat\.?|ft\.?|featuring)\s.+$/giu;

/** The first artist of a credit like "A feat. B", "A & B", "A, B". */
export function leadArtist(credit: string): string {
  const first = credit.split(/\s+(?:feat\.?|ft\.?|featuring|with|x|vs\.?)\s+|,\s*|\s*;\s*/i)[0] ?? credit;
  return first.trim() || credit.trim();
}

export function artistKey(credit: string): string {
  return normaliseName(leadArtist(credit));
}

export function titleKey(title: string): string {
  return normaliseTitle(title.replace(FEATURING, ''));
}

export interface TrackNaming {
  artist: string;
  title: string;
  album?: string | null;
  spotify_id?: string | null;
  mbid?: string | null;
}

export interface ListenTrackRow {
  key: string;
  artist: string;
  title: string;
  album: string | null;
  artist_key: string;
  title_key: string;
  spotify_id: string | null;
  mbid: string | null;
}

/** The listen_track row for a track as a source named it. */
export function listenTrack(t: TrackNaming): ListenTrackRow {
  const artist_key = artistKey(t.artist);
  const title_key = titleKey(t.title);
  const key = t.spotify_id ? `spotify:${t.spotify_id}` : t.mbid ? `mbid:${t.mbid}` : `name:${artist_key}|${title_key}`;
  return {
    key,
    artist: t.artist.slice(0, 500),
    title: t.title.slice(0, 500),
    album: t.album ? t.album.slice(0, 500) : null,
    artist_key,
    title_key,
    spotify_id: t.spotify_id ?? null,
    mbid: t.mbid ?? null,
  };
}
