import { env } from 'cloudflare:workers';
import { storeCoverArt } from '../import/coverart';
import { findCover } from '../covers';
import { attachFiles } from '../import/files';
import { fetchArtistImages } from '../artist-images';
import { enrichArtist } from '../artists';
import { fillCreditsFromGenius } from '../genius';
import { detectAnomalies } from '../review';
import { fillFromDeezer, fillSoundFromDeezer } from '../sources/deezer';
import { fillMoreFromMusicBrainz } from '../sources/musicbrainz-more';
import { fillFromDiscogs } from '../sources/discogs';
import { deriveAlbumGenres } from '../genres';
import { ownerId } from '../auth/user';
import { connection, spotifyFor } from '../spotify/client';
import { linkAlbumsToSpotify } from '../spotify/link';
import { fillFromSpotify } from '../spotify/fill';
import { importFromSpotify } from '../import/spotify';
import { planFromMusicBrainz } from '../import/musicbrainz';
import { writePlan } from '../import/write';
import { pushDefinition } from '../spotify/push';
import { runBackup } from '../backup/store';
import { claimNext, complete, fail, requeue, toBack, type JobPayloads, type JobRow } from './queue';
import { MusicBrainzError } from '../musicbrainz/client';
import { mergeTwins } from '../twins';
import { inheritForNewSongs } from '../inherited';

/** An imported release's songs joined to the same recordings already here (twins.ts), so their ratings show. */
async function joinTwins(releaseId: string): Promise<void> {
  const { results } = await env.DB.prepare(`SELECT DISTINCT recording_id AS id FROM track WHERE release_id = ?`).bind(releaseId).all<{ id: string }>();
  await mergeTwins({ budgetMs: 15_000, of: results.map((r) => r.id) }).catch((error) => console.warn('Twins after import failed', error));
  // What is left after the merges: new versions of rated songs borrow their score (0075).
  const { results: left } = await env.DB.prepare(`SELECT DISTINCT recording_id AS id FROM track WHERE release_id = ?`).bind(releaseId).all<{ id: string }>();
  await inheritForNewSongs(left.map((r) => r.id)).catch((error) => console.warn('Borrowed scores after import failed', error));
}

/**
 * Imports are pushed on hard: a job that stalls goes to the back of the
 * queue and the next one starts. Stalling is taking longer than STALL_MS
 * times its tries so far (an import usually takes 18 s, nine in ten under
 * 32 s; a big one gets longer each time round), or MusicBrainz refusing it
 * through all its own retries. After MAX_TRIES it fails, so it can be seen.
 */
const STALL_MS = 120_000;
/**
 * Never longer than this, however many tries: under the 6 minutes after
 * which claimNext takes a running job for a dead one (queue.ts).
 *
 * At 45 s (15 Nov) more than half of all imports were given up on: when
 * MusicBrainz slows the address the Worker shares, an import takes a
 * minute; given up, it went on in the background beside the next one,
 * both slower for it, and more were given up. 48 sent back in an hour
 * against 38 done.
 */
const STALL_CAP_MS = 5 * 60_000;
const stallFor = (attempts: number) => Math.min(STALL_CAP_MS, STALL_MS * Math.max(1, attempts));
const MAX_TRIES = 6;
/** Refused this many times running, MusicBrainz is down or throttling hard: the run stops. */
const REFUSALS_TO_STOP = 3;

const STALLED = Symbol('stalled');

/**
 * The album's own artists, looked up straight away (who they are, other
 * names, pictures) so a new artist's page is complete from the start.
 * Best effort: the import has already succeeded.
 */
async function enrichImportedArtists(releaseGroupId: string, timing?: Record<string, number>): Promise<void> {
  // Two lanes at once. MusicBrainz allows one request a second, so its
  // lookups go one after another; the other sources do not share that
  // limit, and waited behind it for nothing: an import took about 22 s.
  const timed = async (name: string, lane: Promise<void>) => {
    const start = Date.now();
    await lane;
    if (timing) timing[name] = Date.now() - start;
  };
  await Promise.all([timed('musicbrainz', musicBrainzLane(releaseGroupId)), timed('others', otherSourcesLane(releaseGroupId))]);
  await markSettleDue();
}

/** The album's new artists (who they are, other names, pictures), then the rest MusicBrainz knows. */
async function musicBrainzLane(releaseGroupId: string): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT a.id FROM artist_credit c JOIN artist a ON a.id = c.artist_id
     WHERE c.entity_type = 'release_group' AND c.entity_id = ? AND c.role = 'primary' AND a.enriched_at IS NULL`,
  )
    .bind(releaseGroupId)
    .all<{ id: string }>();
  for (const { id } of results) {
    try {
      await enrichArtist(id);
      await fetchArtistImages(id);
    } catch (error) {
      console.warn('Artist enrichment after import failed', id, error);
    }
  }
  // Each track's genres and kind, labels and catalogue numbers, lists and awards.
  await fillMoreFromMusicBrainz(releaseGroupId).catch((error) => console.warn('MusicBrainz more after import failed', error));
}

/** Spotify, Genius, Deezer and Discogs, in their own time. */
async function otherSourcesLane(releaseGroupId: string): Promise<void> {
  // Its Spotify album, when Spotify is connected, so the link is right from the start.
  const owner = await ownerId();
  if (owner && (await connection(owner))) {
    await linkAlbumsToSpotify(spotifyFor(owner), { only: releaseGroupId }).catch((error) => console.warn('Spotify link after import failed', error));
    await fillFromSpotify(spotifyFor(owner), releaseGroupId).catch((error) => console.warn('Spotify fill after import failed', error));
  }
  // Writers MusicBrainz lacks.
  await fillCreditsFromGenius({ albumId: releaseGroupId, budgetMs: 15_000 }).catch((error) => console.warn('Genius after import failed', error));
  await fillFromDeezer(releaseGroupId).catch((error) => console.warn('Deezer after import failed', error));
  // Each track's tempo, loudness and explicit flag.
  await fillSoundFromDeezer(releaseGroupId).catch((error) => console.warn('Deezer tracks after import failed', error));
  // Without a Discogs token this returns at once.
  await fillFromDiscogs(releaseGroupId).catch((error) => console.warn('Discogs after import failed', error));
}

const SETTLE_KEY = 'library_settle_due';
const SETTLED_AT_KEY = 'library_settled_at';
/** The least time between two settles. */
export const SETTLE_EVERY_MS = 20 * 60 * 1000;

/** The library has changed: the whole-library passes are due once the queue empties. */
async function markSettleDue(): Promise<void> {
  await env.DB.prepare(`INSERT INTO app_setting (key, value) VALUES (?1, '1') ON CONFLICT (key) DO UPDATE SET value = '1'`)
    .bind(SETTLE_KEY)
    .run();
}

/**
 * The passes that look at the whole library, a fresh look for lookalikes
 * (the same song on another release, "dustcutter" here and "DUSTCUTTER"
 * there, raised for review straight away rather than at night) and album
 * genres from track genres, run once after a batch of imports rather than
 * after each album: each reads the whole library, so a discography of
 * forty albums ran them forty times. Nothing runs while imports are still
 * waiting; the run that empties the queue does it. Taking the flag is one
 * UPDATE, so two overlapping runs never both settle.
 */
export async function settleIfIdle(now = new Date()): Promise<boolean> {
  const waiting = await env.DB.prepare(`SELECT 1 AS yes FROM job WHERE status = 'queued' LIMIT 1`).first();
  if (waiting) return false;
  // At most every SETTLE_EVERY_MS: a long import drip-fed into the queue
  // empties it between albums, and settled each time (146 times in a day,
  // 45 million rows). The mark stays set, so a later run settles it.
  const since = new Date(now.getTime() - SETTLE_EVERY_MS).toISOString();
  const taken = await env.DB.prepare(
    `UPDATE app_setting SET value = '0'
     WHERE key = ?1 AND value = '1'
       AND NOT EXISTS (SELECT 1 FROM app_setting t WHERE t.key = ?2 AND t.value > ?3)`,
  )
    .bind(SETTLE_KEY, SETTLED_AT_KEY, since)
    .run();
  if ((taken.meta.changes ?? 0) === 0) return false;
  await env.DB.prepare(`INSERT INTO app_setting (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
    .bind(SETTLED_AT_KEY, now.toISOString())
    .run();
  await detectAnomalies().catch((error) => console.warn('Review check after imports failed', error));
  await deriveAlbumGenres().catch((error) => console.warn('Genre derivation after imports failed', error));
  return true;
}

async function importRelease(job: JobRow): Promise<void> {
  const payload = JSON.parse(job.payload_json) as JobPayloads['import_release'];
  if (payload.source === 'spotify') {
    const result = await importFromSpotify(payload.target);
    await joinTwins(result.releaseId);
    await enrichImportedArtists(result.releaseGroupId);
    await complete(job.id, { ...payload, result: { releaseGroupId: result.releaseGroupId, via: result.via } }, 1);
    return;
  }
  // Where an import's time goes, in the log (wrangler tail): plan, write, art, then the two lanes.
  const timing: Record<string, number> = {};
  let mark = Date.now();
  const lap = (stage: string) => {
    timing[stage] = Date.now() - mark;
    mark = Date.now();
  };
  const plan = await planFromMusicBrainz(payload.target);
  lap('plan');
  const result = await writePlan(plan);
  lap('write');
  await joinTwins(result.releaseId);
  lap('twins');

  // Art is best-effort: an album without a cover is still an album, and the
  // review queue reports releases with no art.
  const hasArt = await env.DB.prepare('SELECT art_key FROM release WHERE id = ?')
    .bind(result.releaseId)
    .first<{ art_key: string | null }>();
  const releaseMbid = plan.release.mbid;
  const releaseGroupMbid = plan.releaseGroup.mbid;
  if (!hasArt?.art_key && releaseMbid && releaseGroupMbid) {
    try {
      // Its own scan, then its Spotify cover, then the album-wide front.
      (await storeCoverArt({ releaseId: result.releaseId, releaseMbid, releaseGroupMbid, groupFallback: false })) ??
        (await findCover(result.releaseId, { replace: false }));
    } catch (error) {
      console.warn('Cover art failed', error);
    }
  }

  lap('art');
  const filesAttached = payload.files?.length ? await attachFiles(result.releaseId, payload.files) : undefined;
  await enrichImportedArtists(result.releaseGroupId, timing);
  console.log('Import timing (ms)', JSON.stringify(timing));

  // The file list has done its job; keep the payload small.
  const { files: _files, ...rest } = payload;
  await complete(job.id, { ...rest, result: { releaseGroupId: result.releaseGroupId, filesAttached, timing } }, 1);
}

async function spotifyPush(job: JobRow): Promise<void> {
  const payload = JSON.parse(job.payload_json) as JobPayloads['spotify_push'];
  const report = await pushDefinition(payload.definitionId);
  await complete(job.id, { ...payload, result: report }, report.pushed);
}

async function backup(job: JobRow): Promise<void> {
  const report = await runBackup();
  await complete(job.id, { result: report }, report.summary.rows);
}

const handlers: Partial<Record<JobRow['kind'], (job: JobRow) => Promise<void>>> = {
  import_release: importRelease,
  spotify_push: spotifyPush,
  backup,
};

/** Workers cap the requests one invocation may make; this is the error when it runs out. */
export function isSubrequestLimit(error: unknown): boolean {
  return /too many subrequests/i.test(error instanceof Error ? error.message : String(error));
}

/**
 * Works through queued jobs until the queue is empty or the time budget is
 * spent. Jobs that fail are recorded with their error and left for a retry;
 * they never stop the jobs behind them.
 *
 * The one exception is running out of requests. Every job in an invocation
 * shares one allowance, so a job that runs out after others have spent
 * some is not at fault: it goes back to the front of the queue and this run
 * stops, so the next starts it with the whole allowance. Only a job that
 * runs out on a fresh allowance is too big, and fails.
 */
export async function runJobs({ budgetMs }: { budgetMs: number }): Promise<number> {
  const deadline = Date.now() + budgetMs;
  let processed = 0;
  // One run at a time across every Worker: see lease().
  const token = crypto.randomUUID();
  if (!(await lease(token, STALL_MS + 15_000))) return 0;

  try {
    processed = await work(deadline, token);
  } finally {
    await release(token).catch(() => {});
  }
  await settleIfIdle().catch((error) => console.warn('Settling after imports failed', error));
  return processed;
}

/**
 * The runner's lease, in app_setting as "<until>|<token>". Two runs at once
 * (the cron's next minute while the last still ran, a run started by a page
 * beside it) each kept MusicBrainz's one request a second on their own, and
 * together went faster: 503s, and imports to the back of the queue. Taken
 * only when free or expired; renewed before each job, for as long as it may
 * take; given up at the end.
 */
async function lease(token: string, forMs: number): Promise<boolean> {
  const now = new Date().toISOString();
  const value = `${new Date(Date.now() + forMs).toISOString()}|${token}`;
  const result = await env.DB.prepare(
    `INSERT INTO app_setting (key, value) VALUES ('jobs_lease', ?1)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value
     WHERE app_setting.value < ?2 OR app_setting.value LIKE '%|' || ?3`,
  )
    .bind(value, now, token)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * A run started by a page (an import queued, a status poll): only when no
 * run holds the lease, and only starting jobs in its first 10 s, so it ends
 * inside the 30 s a page's background work is given. A 25 s budget started
 * jobs at 24 s that were cut off mid-way. The cron does the bulk.
 */
export function kickJobs(ctx: { waitUntil(promise: Promise<unknown>): void }): void {
  ctx.waitUntil(runJobs({ budgetMs: 10_000 }).catch((error) => console.warn('Job run from a page failed', error)));
}

async function release(token: string): Promise<void> {
  await env.DB.prepare(`UPDATE app_setting SET value = '' WHERE key = 'jobs_lease' AND value LIKE '%|' || ?1`).bind(token).run();
}

async function work(deadline: number, token: string): Promise<number> {
  let processed = 0;
  let refusals = 0;
  while (Date.now() < deadline) {
    const job = await claimNext();
    if (!job) break;
    // Held for as long as this job may run before it counts as stalled.
    await lease(token, stallFor(job.attempts) + 15_000);

    const handler = handlers[job.kind];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!handler) throw new Error(`No handler for job kind "${job.kind}" yet.`);
      const running = handler(job);
      // Left running if it stalls: imports are idempotent, and one that
      // finishes late still marks itself done.
      running.catch((error) => console.warn(`Job ${job.id} ended after it was moved on from`, error));
      const outcome = await Promise.race([
        running,
        new Promise<typeof STALLED>((resolve) => (timer = setTimeout(() => resolve(STALLED), stallFor(job.attempts)))),
      ]);
      if (outcome === STALLED) {
        if (job.attempts < MAX_TRIES) {
          console.warn(`Job ${job.id} stalled; to the back of the queue`);
          await toBack(job.id);
        } else {
          await fail(job.id, new Error(`Stalled on each of ${MAX_TRIES} tries.`));
        }
      }
      refusals = 0;
    } catch (error) {
      if (processed > 0 && isSubrequestLimit(error)) {
        console.warn(`Job ${job.id} ran out of requests after ${processed} others; it goes first next run`);
        await requeue(job.id);
        break;
      }
      // MusicBrainz said "not now" through all its own retries: it is
      // throttling (Workers share addresses with others' apps). Not the
      // job's fault: to the back, and on with the next. Refused several
      // times running, it is down: the run stops to give it a rest.
      if (error instanceof MusicBrainzError && error.status === 503 && job.attempts < MAX_TRIES) {
        console.warn(`Job ${job.id}: MusicBrainz refused it; to the back of the queue`);
        await toBack(job.id);
        if (++refusals >= REFUSALS_TO_STOP) break;
        continue;
      }
      console.error(`Job ${job.id} (${job.kind}) failed`, error);
      await fail(job.id, error);
    } finally {
      clearTimeout(timer);
    }
    processed++;
  }
  return processed;
}
