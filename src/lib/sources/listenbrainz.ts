/**
 * ListenBrainz (api.listenbrainz.org/1): a user's listens, for listening
 * history. Public listens need only the username; a user token is sent when
 * there is one. Listens often carry the recording's MusicBrainz id, which
 * matches the catalogue exactly.
 */

import type { Scrobble } from './lastfm';

type Fetcher = typeof fetch;
const API = 'https://api.listenbrainz.org/1';

const headers = (token?: string): HeadersInit => ({
  accept: 'application/json',
  'user-agent': 'music.cillianloftus.com',
  ...(token ? { authorization: `Token ${token}` } : {}),
});

/** Whether a token is valid; resolves to the user it belongs to. */
export async function validateToken(token: string, fetcher: Fetcher = fetch): Promise<string> {
  const res = await fetcher(`${API}/validate-token`, { headers: headers(token) });
  const body = (await res.json().catch(() => ({}))) as { valid?: boolean; user_name?: string; message?: string };
  if (!body.valid || !body.user_name) throw new Error(body.message ?? 'ListenBrainz did not accept that token.');
  return body.user_name;
}

/** How many listens a user has; also proves the username exists. */
export async function listenCount(user: string, token?: string, fetcher: Fetcher = fetch): Promise<number> {
  const res = await fetcher(`${API}/user/${encodeURIComponent(user)}/listen-count`, { headers: headers(token) });
  if (res.status === 404) throw new Error(`ListenBrainz has no user called “${user}”.`);
  if (!res.ok) throw new Error(`ListenBrainz answered ${res.status}.`);
  const body = (await res.json()) as { payload: { count: number } };
  return body.payload.count;
}

interface RawListen {
  listened_at: number;
  track_metadata: {
    artist_name: string;
    track_name: string;
    release_name?: string;
    additional_info?: {
      recording_mbid?: string;
      duration_ms?: number;
      duration?: number;
      spotify_id?: string;
      media_player?: string;
      music_service_name?: string;
      submission_client?: string;
    };
    mbid_mapping?: { recording_mbid?: string };
  };
}

/** A listen's length, when given: duration_ms, or duration in seconds. */
function durationOf(info: RawListen['track_metadata']['additional_info']): number | null {
  if (typeof info?.duration_ms === 'number' && info.duration_ms > 0) return Math.round(info.duration_ms);
  if (typeof info?.duration === 'number' && info.duration > 0) return Math.round(info.duration * 1000);
  return null;
}

/** Listens before a time (seconds, exclusive), newest first, up to 1000. */
export async function listensBefore(user: string, before: number, token?: string, fetcher: Fetcher = fetch): Promise<Scrobble[]> {
  const url = `${API}/user/${encodeURIComponent(user)}/listens?count=1000&max_ts=${before}`;
  const res = await fetcher(url, { headers: headers(token) });
  if (!res.ok) throw new Error(`ListenBrainz answered ${res.status}.`);
  const body = (await res.json()) as { payload: { listens: RawListen[] } };
  return body.payload.listens.map((l) => ({
    artist: l.track_metadata.artist_name,
    title: l.track_metadata.track_name,
    album: l.track_metadata.release_name ?? null,
    mbid: l.track_metadata.mbid_mapping?.recording_mbid ?? l.track_metadata.additional_info?.recording_mbid ?? null,
    at: l.listened_at,
    duration_ms: durationOf(l.track_metadata.additional_info),
    spotify_id: l.track_metadata.additional_info?.spotify_id?.match(/track[/:]([A-Za-z0-9]{22})/)?.[1] ?? null,
    player:
      l.track_metadata.additional_info?.media_player ??
      l.track_metadata.additional_info?.music_service_name ??
      l.track_metadata.additional_info?.submission_client ??
      null,
  }));
}
