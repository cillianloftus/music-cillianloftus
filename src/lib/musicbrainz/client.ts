/**
 * MusicBrainz web service client.
 *
 * MusicBrainz asks for a meaningful User-Agent and about one request per
 * second per client; exceeding it returns 503. Requests from one isolate are
 * serialised through `throttle` and 503s are retried with backoff.
 * https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting
 */

import type { MbRelease, MbReleaseGroup, MbReleaseSummary } from './types';

const BASE = 'https://musicbrainz.org/ws/2';
const USER_AGENT = 'music-cillianloftus/0.1 ( https://music.cillianloftus.com )';
const MIN_INTERVAL_MS = 1100;
const MAX_ATTEMPTS = 4;

let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

/** Runs `task` after every earlier task, at least MIN_INTERVAL_MS apart. */
function throttle<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return task();
  });
  queue = run.catch(() => undefined);
  return run;
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

async function get<T>(path: string, inc: string[]): Promise<T> {
  const separator = path.includes('?') ? '&' : '?';
  const url = `${BASE}/${path}${separator}fmt=json${inc.length ? `&inc=${inc.join('+')}` : ''}`;

  for (let attempt = 1; ; attempt++) {
    const response = await throttle(() =>
      fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } }),
    );
    if (response.ok) return (await response.json()) as T;

    if (response.status === 503 && attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      continue;
    }
    if (response.status === 404) throw new MusicBrainzError(`Not found on MusicBrainz: ${path}`, 404);
    throw new MusicBrainzError(`MusicBrainz returned ${response.status} for ${path}`, response.status);
  }
}

/** A release with everything an import needs, in one request. */
export function getRelease(mbid: string): Promise<MbRelease> {
  return get<MbRelease>(`release/${mbid}`, [
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
  ]);
}

export function getReleaseGroup(mbid: string): Promise<MbReleaseGroup> {
  return get<MbReleaseGroup>(`release-group/${mbid}`, ['artist-credits', 'genres']);
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
