/**
 * Listening history from Last.fm and ListenBrainz, synced into the same
 * play table as the Spotify export, so every comparison of rated against
 * played sees all three.
 *
 * Both services page newest first. A sync walks back from the moment it
 * started until it meets what an earlier sync already took, saving its
 * place after every page; so a first sync of years of scrobbles can span
 * several nightly runs and pick up where it stopped, and later syncs only
 * fetch what is new. Only scrobbles of recordings in the catalogue are
 * stored. Overlap is harmless: plays are unique per recording, time and
 * source.
 */

import { env } from 'cloudflare:workers';
import { ownerId } from './auth/user';
import { checkConnection } from './connection-check';
import { credentials, recordCheck, recordSync, stateOf, type ServiceId } from './connections';
import { scrobblesBetween, type Scrobble } from './sources/lastfm';
import { listensBefore } from './sources/listenbrainz';
import { normaliseName, normaliseTitle } from './text';

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

/** Splits "A feat. B", "A & B", "A, B" into the names a credit might use. */
export function artistNames(credit: string): string[] {
  const whole = normaliseName(credit);
  const parts = credit
    .split(/\s+(?:feat\.?|ft\.?|featuring|with|x|&|and|vs\.?)\s+|,\s*|\s*;\s*/i)
    .map((p) => normaliseName(p))
    .filter(Boolean);
  return [...new Set([whole, ...parts])];
}

interface IndexRow {
  id: string;
  title: string;
  mbid: string | null;
  length_ms: number | null;
  artists: string | null;
  albums: string | null;
}

export interface CatalogueIndex {
  byMbid: Map<string, IndexRow>;
  byName: Map<string, IndexRow[]>;
}

export async function catalogueIndex(): Promise<CatalogueIndex> {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.title, r.mbid, r.length_ms,
            (SELECT json_group_array(a.name) FROM artist_credit c JOIN artist a ON a.id = c.artist_id
             WHERE c.entity_type = 'recording' AND c.entity_id = r.id AND c.role IN ('primary', 'featured')) AS artists,
            (SELECT json_group_array(g.title) FROM track t JOIN release x ON x.id = t.release_id
             JOIN release_group g ON g.id = x.release_group_id WHERE t.recording_id = r.id) AS albums
     FROM recording r`,
  ).all<IndexRow>();
  const byMbid = new Map<string, IndexRow>();
  const byName = new Map<string, IndexRow[]>();
  for (const row of results) {
    if (row.mbid) byMbid.set(row.mbid, row);
    const title = normaliseTitle(row.title);
    for (const artist of JSON.parse(row.artists ?? '[]') as string[]) {
      const key = `${normaliseName(artist)}\u0000${title}`;
      const list = byName.get(key);
      if (list) list.push(row);
      else byName.set(key, [row]);
    }
  }
  return { byMbid, byName };
}

/** The recording a scrobble is of, if it is in the catalogue. */
export function matchScrobble(index: CatalogueIndex, s: Scrobble): IndexRow | null {
  if (s.mbid) {
    const exact = index.byMbid.get(s.mbid);
    if (exact) return exact;
  }
  const title = normaliseTitle(s.title);
  const album = s.album ? normaliseTitle(s.album) : null;
  for (const artist of artistNames(s.artist)) {
    const candidates = index.byName.get(`${artist}\u0000${title}`);
    if (!candidates?.length) continue;
    const onAlbum = album ? candidates.find((c) => (JSON.parse(c.albums ?? '[]') as string[]).some((a) => normaliseTitle(a) === album)) : undefined;
    return onAlbum ?? candidates[0]!;
  }
  return null;
}

async function store(userId: string, source: ScrobbleSource, index: CatalogueIndex, page: Scrobble[]): Promise<{ matched: number; added: number }> {
  const rows = [];
  for (const s of page) {
    const hit = matchScrobble(index, s);
    if (!hit) continue;
    rows.push({ id: crypto.randomUUID(), recording_id: hit.id, played_at: new Date(s.at * 1000).toISOString(), ms_played: hit.length_ms ?? 0 });
  }
  if (rows.length === 0) return { matched: 0, added: 0 };
  const result = await env.DB.prepare(
    `INSERT INTO play (id, user_id, recording_id, played_at, ms_played, source)
     SELECT j.value ->> '$.id', ?1, j.value ->> '$.recording_id', j.value ->> '$.played_at', j.value ->> '$.ms_played', ?3
     FROM json_each(?2) j
     WHERE true
     ON CONFLICT (user_id, recording_id, played_at, source) DO NOTHING`,
  )
    .bind(userId, JSON.stringify(rows), source)
    .run();
  return { matched: rows.length, added: result.meta.changes ?? 0 };
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

  try {
    for (;;) {
      if (Date.now() > deadline) {
        report.complete = false;
        await recordSync(source, JSON.stringify({ through: cursor.through, pending: walk } satisfies Cursor));
        return report;
      }
      const batch = (await page({ after: cursor.through, before: walk.before })).filter((s) => s.at > cursor.through && s.at < walk.before);
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
