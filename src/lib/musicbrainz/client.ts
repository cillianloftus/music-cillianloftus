/**
 * MusicBrainz web service client.
 *
 * MusicBrainz asks for a meaningful User-Agent and about one request per
 * second per client; exceeding it returns 503. Requests from one isolate are
 * serialised through `throttle` and 503s are retried with backoff.
 * https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting
 */

import type { MbRelease, MbReleaseGroup, MbReleaseSummary } from './types';

/** An artist with what enrichment reads: type, life span, areas, aliases, links. */
export interface MbArtistDetails {
  id: string;
  name: string;
  type?: string | null;
  'life-span'?: { begin?: string | null; end?: string | null; ended?: boolean };
  area?: { name: string } | null;
  'begin-area'?: { name: string } | null;
  aliases?: { name: string; type?: string | null }[];
  relations?: {
    type: string;
    'target-type': string;
    direction?: 'forward' | 'backward';
    artist?: { id: string; name: string };
    url?: { resource: string };
    /** When it held: "1985", "1991-04". */
    begin?: string | null;
    end?: string | null;
  }[];
}

const BASE = 'https://musicbrainz.org/ws/2';
const USER_AGENT = 'music-cillianloftus/0.1 ( https://music.cillianloftus.com )';
const MIN_INTERVAL_MS = 1100;
const MAX_INTERVAL_MS = 5000;
/**
 * Tries before a 503 is given up on. Refused, an import used to go to the
 * back of the queue and its work so far was lost; the next one met the
 * same refusal. Waiting longer here (2, 4, 8, 16, 16 s) costs less.
 */
const MAX_ATTEMPTS = 6;

/** The earliest time the next request may start. */
let nextSlot = 0;
/**
 * The gap between requests: 1.1 s, stretched after a 503 and eased back as
 * requests succeed. MusicBrainz limits by address, and a Worker's address is
 * shared with other people's apps, so even one request a second from here
 * is sometimes too many; on 14 Nov most imports were refused for a while.
 */
let interval = MIN_INTERVAL_MS;

/**
 * Runs `task` at least `interval` after the last one started. Each
 * caller reserves the next free slot and waits for it on its own timer:
 * nothing is shared between requests but a number. (Chaining every call
 * onto one shared promise made a request wait on another's promise, which
 * the Workers runtime cancels as hung when two run at once.)
 */
async function throttle<T>(task: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + interval;
  if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  return task();
}

export class MusicBrainzError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'MusicBrainzError';
  }
}

/**
 * Answers kept a few minutes, by address: an import asks for a release and
 * its group, and straight after, the pass for what it does not take
 * (musicbrainz-more.ts) asked for the same two again. With one request a
 * second the most MusicBrainz allows, every one saved is a second or more
 * off each import. Kept as text, so no caller can change another's copy.
 */
const recent = new Map<string, { at: number; text: string }>();
const RECENT_MS = 10 * 60_000;
const RECENT_MAX = 24;

function remembered(url: string): string | null {
  const hit = recent.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > RECENT_MS) {
    recent.delete(url);
    return null;
  }
  return hit.text;
}

function remember(url: string, text: string): void {
  recent.set(url, { at: Date.now(), text });
  while (recent.size > RECENT_MAX) recent.delete(recent.keys().next().value!);
}

async function get<T>(path: string, inc: string[]): Promise<T> {
  const separator = path.includes('?') ? '&' : '?';
  const url = `${BASE}/${path}${separator}fmt=json${inc.length ? `&inc=${inc.join('+')}` : ''}`;
  const kept = remembered(url);
  if (kept !== null) return JSON.parse(kept) as T;

  for (let attempt = 1; ; attempt++) {
    const response = await throttle(() =>
      fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } }),
    );
    if (response.ok) {
      interval = Math.max(MIN_INTERVAL_MS, interval - 250);
      const text = await response.text();
      remember(url, text);
      return JSON.parse(text) as T;
    }

    if (response.status === 503) interval = Math.min(MAX_INTERVAL_MS, interval * 2);
    if (response.status === 503 && attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * Math.min(16, 2 ** attempt)));
      continue;
    }
    if (response.status === 404) throw new MusicBrainzError(`Not found on MusicBrainz: ${path}`, 404);
    throw new MusicBrainzError(`MusicBrainz returned ${response.status} for ${path}`, response.status);
  }
}

/**
 * Everything asked of a release, by the import and by the pass for what
 * it does not take (src/lib/sources/musicbrainz-more.ts: each track's
 * genres and rating, cover and live marks, catalogue numbers), in one
 * request: the same address, so the second is answered from memory.
 */
const RELEASE_INC = [
  'artist-credits',
  'labels',
  'recordings',
  'release-groups',
  'isrcs',
  // Credits: artist relationships on the release and on each recording,
  // and writers via each recording's work.
  'artist-rels',
  'recording-level-rels',
  'work-rels',
  'work-level-rels',
  'genres',
  'ratings',
];

/** The same for a release group: its artists and genres, and the lists and series it is in. */
const GROUP_INC = ['artist-credits', 'genres', 'series-rels'];

/** A release with everything an import needs, in one request. */
export function getRelease(mbid: string): Promise<MbRelease> {
  return get<MbRelease>(`release/${mbid}`, RELEASE_INC);
}

/** A release with what the import does not take: the same request as getRelease, so usually from memory. */
export function getReleaseMore<T>(mbid: string): Promise<T> {
  return get<T>(`release/${mbid}`, RELEASE_INC);
}

/** The lists and series an album is part of: the same request as getReleaseGroup. */
export function getReleaseGroupSeries<T>(mbid: string): Promise<T> {
  return get<T>(`release-group/${mbid}`, GROUP_INC);
}

export function getReleaseGroup(mbid: string): Promise<MbReleaseGroup> {
  return get<MbReleaseGroup>(`release-group/${mbid}`, GROUP_INC);
}

const BROWSE_PAGE = 100;
/** Albums like Thriller have hundreds of pressings; this is plenty to find the original. */
const BROWSE_MAX = 500;

/**
 * Every edition of a release group, with track counts. A release-group
 * lookup lists editions but not their tracklists, and choosing the
 * standard edition needs the counts.
 */
export async function browseReleases(releaseGroupMbid: string): Promise<MbReleaseSummary[]> {
  const releases: MbReleaseSummary[] = [];
  for (let offset = 0; offset < BROWSE_MAX; offset += BROWSE_PAGE) {
    const page = await get<{ releases: MbReleaseSummary[]; 'release-count': number }>(
      `release?release-group=${releaseGroupMbid}&limit=${BROWSE_PAGE}&offset=${offset}`,
      ['media'],
    );
    releases.push(...page.releases);
    if (releases.length >= page['release-count'] || page.releases.length === 0) break;
  }
  return releases;
}

/**
 * Releases carrying a barcode (UPC/EAN), best match first. How an album
 * found elsewhere (Spotify gives its UPC) is looked up here first, since
 * MusicBrainz has the richer record.
 */
export async function releasesByBarcode(barcode: string): Promise<{ id: string; score: number; title: string }[]> {
  if (!/^\d{8,14}$/.test(barcode)) return [];
  const page = await get<{ releases?: { id: string; score: number; title: string }[] }>(
    `release?query=barcode:${barcode}&limit=5`,
    [],
  );
  return (page.releases ?? []).map(({ id, score, title }) => ({ id, score, title }));
}

/** One artist, with aliases, links to other artists and to other sites. */
export function getArtistDetails(mbid: string): Promise<MbArtistDetails> {
  return get<MbArtistDetails>(`artist/${mbid}`, ['aliases', 'artist-rels', 'url-rels']);
}

export interface MbReleaseGroupSummary {
  id: string;
  title: string;
  'primary-type': string | null;
  'secondary-types'?: string[];
  'first-release-date'?: string;
}

/** Every release group an artist is credited on as the artist, all pages. */
/**
 * An artist's release groups as MusicBrainz's own site lists them: only
 * groups with an official release. Without the filter the list carries
 * every bootleg, fan-made "album" and unofficial mixtape anyone has entered.
 */
export async function browseArtistReleaseGroups(artistMbid: string): Promise<MbReleaseGroupSummary[]> {
  const groups: MbReleaseGroupSummary[] = [];
  for (let offset = 0; offset < 2000; offset += BROWSE_PAGE) {
    const page = await get<{ 'release-groups': MbReleaseGroupSummary[]; 'release-group-count': number }>(
      `release-group?artist=${artistMbid}&release-group-status=website-default&limit=${BROWSE_PAGE}&offset=${offset}`,
      [],
    );
    groups.push(...page['release-groups']);
    if (groups.length >= page['release-group-count'] || page['release-groups'].length === 0) break;
  }
  return groups;
}

/** Artists by name, best match first. */
export async function searchArtists(name: string): Promise<{ id: string; name: string; score: number; disambiguation?: string }[]> {
  const page = await get<{ artists?: { id: string; name: string; score: number; disambiguation?: string }[] }>(
    `artist?query=${encodeURIComponent(`artist:"${name.replace(/"/g, '')}"`)}&limit=5`,
    [],
  );
  return page.artists ?? [];
}

/** The MusicBrainz artist linked to a Spotify artist page, if any. */
export async function artistForSpotify(spotifyId: string): Promise<{ id: string; name: string } | null> {
  try {
    const page = await get<{ relations?: { artist?: { id: string; name: string } }[] }>(
      `url?resource=${encodeURIComponent(`https://open.spotify.com/artist/${spotifyId}`)}`,
      ['artist-rels'],
    );
    return page.relations?.find((r) => r.artist)?.artist ?? null;
  } catch (error) {
    if (error instanceof MusicBrainzError && error.status === 404) return null;
    throw error;
  }
}
