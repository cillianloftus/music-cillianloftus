/**
 * Last.fm's API (ws.audioscrobbler.com/2.0): scrobbles for listening
 * history, and artist facts (listeners, similar artists, tags) for artist
 * pages. Needs an API key from /manage/connections; read-only calls only,
 * so no shared secret or session is involved.
 */

type Fetcher = typeof fetch;
const API = 'https://ws.audioscrobbler.com/2.0/';

export class LastfmError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

async function call<T>(key: string, method: string, params: Record<string, string | number | undefined>, fetcher: Fetcher): Promise<T> {
  const url = new URL(API);
  url.searchParams.set('method', method);
  url.searchParams.set('api_key', key);
  url.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  const res = await fetcher(url, { headers: { accept: 'application/json', 'user-agent': 'music.cillianloftus.com' } });
  const body = (await res.json().catch(() => null)) as (T & { error?: number; message?: string }) | null;
  if (!body) throw new LastfmError(`Last.fm answered ${res.status}`, null);
  // Errors come back as { error: 10, message: "Invalid API key" }, sometimes with a 200.
  if (body.error) throw new LastfmError(body.message ?? `Last.fm error ${body.error}`, body.error);
  return body;
}

export interface LastfmUser {
  name: string;
  playcount: number;
  registered: number | null;
}

export async function userInfo(key: string, user: string, fetcher: Fetcher = fetch): Promise<LastfmUser> {
  const body = await call<{ user: { name: string; playcount: string; registered?: { unixtime?: string } } }>(key, 'user.getinfo', { user }, fetcher);
  return {
    name: body.user.name,
    playcount: Number(body.user.playcount) || 0,
    registered: body.user.registered?.unixtime ? Number(body.user.registered.unixtime) : null,
  };
}

/** A key works if Last.fm will answer a harmless question with it. */
export async function checkKey(key: string, fetcher: Fetcher = fetch): Promise<void> {
  await call(key, 'artist.getinfo', { artist: 'Radiohead' }, fetcher);
}

export interface Scrobble {
  artist: string;
  title: string;
  album: string | null;
  /** The recording's MusicBrainz id, when Last.fm knows it. */
  mbid: string | null;
  /** Seconds since the epoch. */
  at: number;
}

interface RawTrack {
  name: string;
  mbid?: string;
  artist: { '#text'?: string; name?: string };
  album?: { '#text'?: string };
  date?: { uts: string };
  '@attr'?: { nowplaying?: string };
}

/**
 * One page of scrobbles between two times (seconds, exclusive), newest
 * first, up to 200. The track playing right now has no date and is left out.
 */
export async function scrobblesBetween(
  key: string,
  user: string,
  window: { after: number; before: number },
  fetcher: Fetcher = fetch,
): Promise<Scrobble[]> {
  const body = await call<{ recenttracks: { track: RawTrack[] | RawTrack } }>(
    key,
    'user.getrecenttracks',
    { user, limit: 200, page: 1, from: window.after + 1, to: window.before - 1 },
    fetcher,
  );
  const raw = body.recenttracks.track;
  const tracks = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return tracks
    .filter((t) => t.date?.uts && !t['@attr']?.nowplaying)
    .map((t) => ({
      artist: t.artist['#text'] ?? t.artist.name ?? '',
      title: t.name,
      album: t.album?.['#text'] || null,
      mbid: t.mbid || null,
      at: Number(t.date!.uts),
    }))
    .filter((s) => s.artist && s.title);
}

export interface LastfmArtist {
  url: string;
  listeners: number;
  playcount: number;
  /** The connected user's own scrobbles of them, when a username is set. */
  userPlaycount: number | null;
  similar: { name: string; url: string }[];
  tags: string[];
}

export async function artistInfo(
  key: string,
  artist: { name: string; mbid: string | null },
  username: string | undefined,
  fetcher: Fetcher = fetch,
): Promise<LastfmArtist | null> {
  type Body = {
    artist: {
      url: string;
      stats: { listeners: string; playcount: string; userplaycount?: string };
      similar?: { artist: { name: string; url: string }[] };
      tags?: { tag: { name: string }[] };
    };
  };
  const ask = (params: Record<string, string | undefined>) => call<Body>(key, 'artist.getinfo', { ...params, username, autocorrect: 1 }, fetcher);
  let body: Body | null = null;
  // By MusicBrainz id first (exact), then by name; Last.fm's mbids are patchy.
  if (artist.mbid) body = await ask({ mbid: artist.mbid }).catch(() => null);
  body ??= await ask({ artist: artist.name }).catch((error) => {
    if (error instanceof LastfmError && error.code === 6) return null; // not found
    throw error;
  });
  if (!body?.artist) return null;
  const a = body.artist;
  return {
    url: a.url,
    listeners: Number(a.stats.listeners) || 0,
    playcount: Number(a.stats.playcount) || 0,
    userPlaycount: a.stats.userplaycount != null ? Number(a.stats.userplaycount) : null,
    similar: (a.similar?.artist ?? []).slice(0, 8).map((s) => ({ name: s.name, url: s.url })),
    tags: (a.tags?.tag ?? []).map((t) => t.name.toLowerCase()).slice(0, 6),
  };
}
