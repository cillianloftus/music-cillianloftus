/**
 * Listening history from Last.fm and ListenBrainz, synced into the same
 * play table as the Spotify export, so every comparison of rated against
 * played sees all three.
 *
 * Both services page newest first. A sync walks back from the moment it
 * started until it meets what an earlier sync already took, saving its
 * place after every page; so a first sync of years of scrobbles can span
 * several nightly runs and pick up where it stopped, and later syncs only
 * fetch what is new. Every scrobble is kept, in the catalogue or not.
 * Overlap is harmless: plays are unique per track, time and source, and
 * a scrobble of a stream the Spotify export (or the other service) also
 * has counts once (listens/dedupe.ts).
 */

import { env } from 'cloudflare:workers';
import { ownerId } from './auth/user';
import { checkConnection } from './connection-check';
import { credentials, recordCheck, recordSync, stateOf, type ServiceId } from './connections';
import { scrobblesBetween, type Scrobble } from './sources/lastfm';
import { listensBefore } from './sources/listenbrainz';
import { listenTrack, type ListenTrackRow } from './listens/keys';
import { artistNames, catalogueIndex, type CatalogueIndex } from './listens/match';
import { savePlays, saveTracks, type NewPlay } from './listens/store';

/** How far back a late scrobble can land. */
const LATE_SECONDS = 14 * 24 * 60 * 60;

export type ScrobbleSource = Extract<ServiceId, 'lastfm' | 'listenbrainz'>;

/** Where a sync has got to. Everything at or before `through` is in; `pending` is a walk under way. */
export interface Cursor {
  through: number;
  pending?: { to: number; before: number };
}

export function parseCursor(raw: string | null): Cursor {
  try {
    const value = JSON.parse(raw ?? '') as Cursor;
    if (typeof value.through === 'number') return value;
  } catch {
    /* First sync. */
  }
  return { through: 0 };
}

export { artistNames };

/** Keeps a page of scrobbles: every one, in the catalogue or not. */
async function store(userId: string, source: ScrobbleSource, index: CatalogueIndex, page: Scrobble[]): Promise<{ matched: number; added: number }> {
  const tracks = new Map<string, ListenTrackRow>();
  const plays: NewPlay[] = [];
  for (const s of page) {
    const track = listenTrack({ artist: s.artist, title: s.title, album: s.album, mbid: s.mbid, spotify_id: s.spotify_id ?? null });
    tracks.set(track.key, track);
    plays.push({
      track_key: track.key,
      played_at: new Date(s.at * 1000).toISOString(),
      // Last.fm never says how long; ListenBrainz sometimes does.
      ms_played: s.duration_ms ?? null,
      platform: s.player ?? null,
    });
  }
  const matched = await saveTracks([...tracks.values()], index);
  const added = await savePlays(userId, source, plays);
  return { matched, added };
}

export interface SyncReport {
  source: ScrobbleSource;
  fetched: number;
  matched: number;
  added: number;
  /** False when the time ran out with older scrobbles still to fetch. */
  complete: boolean;
  skipped?: 'no-credentials';
}

type PageFetcher = (window: { after: number; before: number }) => Promise<Scrobble[]>;

async function pager(source: ScrobbleSource): Promise<PageFetcher | null> {
  const creds = await credentials(source);
  if (!creds?.username) return null;
  if (source === 'lastfm') return (window) => scrobblesBetween(creds.api_key!, creds.username!, window);
  return async (window) => (await listensBefore(creds.username!, window.before, creds.token)).filter((s) => s.at > window.after);
}

/** Fetches new scrobbles from one service until done or the time is up. */
export async function syncScrobbles(source: ScrobbleSource, { budgetMs, fetchPage }: { budgetMs: number; fetchPage?: PageFetcher }): Promise<SyncReport> {
  const report: SyncReport = { source, fetched: 0, matched: 0, added: 0, complete: true };
  const page = fetchPage ?? (await pager(source));
  const userId = await ownerId();
  if (!page || !userId) return { ...report, skipped: 'no-credentials' };

  const deadline = Date.now() + budgetMs;
  const state = await stateOf(source);
  const cursor = parseCursor(state?.cursor ?? null);
  const now = Math.floor(Date.now() / 1000);
  const walk = cursor.pending ?? { to: now, before: now + 1 };
  const index = await catalogueIndex();
  // Scrobbles can arrive late (Last.fm takes ones up to two weeks old, from
  // phones that were offline), so each sync looks back that far again.
  // Plays already held are skipped, so the overlap costs nothing.
  const after = cursor.through > 0 ? cursor.through - LATE_SECONDS : 0;

  try {
    for (;;) {
      if (Date.now() > deadline) {
        report.complete = false;
        await recordSync(source, JSON.stringify({ through: cursor.through, pending: walk } satisfies Cursor));
        return report;
      }
      const batch = (await page({ after, before: walk.before })).filter((s) => s.at > after && s.at < walk.before);
      if (batch.length === 0) break;
      report.fetched += batch.length;
      const { matched, added } = await store(userId, source, index, batch);
      report.matched += matched;
      report.added += added;
      walk.before = Math.min(...batch.map((s) => s.at));
      // Save after every page, so a run cut short resumes here.
      await recordSync(source, JSON.stringify({ through: cursor.through, pending: walk } satisfies Cursor));
    }
    await recordSync(source, JSON.stringify({ through: walk.to } satisfies Cursor));
    // Working again after a failure: say so in the usual words.
    if (state?.status === 'failed' && !fetchPage) await checkConnection(source);
  } catch (error) {
    await recordCheck(source, false, error instanceof Error ? error.message.slice(0, 200) : 'Sync failed');
    throw error;
  }
  return report;
}

/** Both services, sharing a time budget; the nightly cron and Sync now use this. */
export async function syncAllScrobbles({ budgetMs }: { budgetMs: number }): Promise<SyncReport[]> {
  const deadline = Date.now() + budgetMs;
  const reports: SyncReport[] = [];
  for (const source of ['lastfm', 'listenbrainz'] as const) {
    const left = deadline - Date.now();
    if (left < 2000) break;
    reports.push(await syncScrobbles(source, { budgetMs: left }).catch((error) => {
      console.warn(`${source} sync failed`, error);
      return { source, fetched: 0, matched: 0, added: 0, complete: false };
    }));
  }
  return reports;
}

/** Plays per source, for the history and connections pages. */
export async function playsBySource(userId: string): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare('SELECT source, count(*) AS n FROM play WHERE user_id = ? GROUP BY source')
    .bind(userId)
    .all<{ source: string; n: number }>();
  return Object.fromEntries(results.map((r) => [r.source, r.n]));
}
