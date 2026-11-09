import { env } from 'cloudflare:workers';
import { storeCoverArt } from '../import/coverart';
import { findCover } from '../covers';
import { attachFiles } from '../import/files';
import { fetchArtistImages } from '../artist-images';
import { enrichArtist } from '../artists';
import { fillCreditsFromGenius } from '../genius';
import { detectAnomalies } from '../review';
import { fillFromDeezer } from '../sources/deezer';
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
import { claimNext, complete, fail, requeue, type JobPayloads, type JobRow } from './queue';

/**
 * The album's own artists, looked up straight away (who they are, other
 * names, pictures) so a new artist's page is complete from the start.
 * Best effort: the import has already succeeded.
 */
async function enrichImportedArtists(releaseGroupId: string): Promise<void> {
  // Its Spotify album too, when Spotify is connected, so the link is right from the start.
  const owner = await ownerId();
  if (owner && (await connection(owner))) {
    await linkAlbumsToSpotify(spotifyFor(owner), { only: releaseGroupId }).catch((error) => console.warn('Spotify link after import failed', error));
    await fillFromSpotify(spotifyFor(owner), releaseGroupId).catch((error) => console.warn('Spotify fill after import failed', error));
  }
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
  // Writers MusicBrainz lacks.
  await fillCreditsFromGenius({ albumId: releaseGroupId, budgetMs: 15_000 }).catch((error) => console.warn('Genius after import failed', error));
  await fillFromDeezer(releaseGroupId).catch((error) => console.warn('Deezer after import failed', error));
  // Without a Discogs token this returns at once.
  await fillFromDiscogs(releaseGroupId).catch((error) => console.warn('Discogs after import failed', error));
  await markSettleDue();
}

const SETTLE_KEY = 'library_settle_due';

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
export async function settleIfIdle(): Promise<boolean> {
  const waiting = await env.DB.prepare(`SELECT 1 AS yes FROM job WHERE status = 'queued' LIMIT 1`).first();
  if (waiting) return false;
  const taken = await env.DB.prepare(`UPDATE app_setting SET value = '0' WHERE key = ?1 AND value = '1'`).bind(SETTLE_KEY).run();
  if ((taken.meta.changes ?? 0) === 0) return false;
  await detectAnomalies().catch((error) => console.warn('Review check after imports failed', error));
  await deriveAlbumGenres().catch((error) => console.warn('Genre derivation after imports failed', error));
  return true;
}

async function importRelease(job: JobRow): Promise<void> {
  const payload = JSON.parse(job.payload_json) as JobPayloads['import_release'];
  if (payload.source === 'spotify') {
    const result = await importFromSpotify(payload.target);
    await enrichImportedArtists(result.releaseGroupId);
    await complete(job.id, { ...payload, result: { releaseGroupId: result.releaseGroupId, via: result.via } }, 1);
    return;
  }
  const plan = await planFromMusicBrainz(payload.target);
  const result = await writePlan(plan);

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

  const filesAttached = payload.files?.length ? await attachFiles(result.releaseId, payload.files) : undefined;
  await enrichImportedArtists(result.releaseGroupId);

  // The file list has done its job; keep the payload small.
  const { files: _files, ...rest } = payload;
  await complete(job.id, { ...rest, result: { releaseGroupId: result.releaseGroupId, filesAttached } }, 1);
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

  while (Date.now() < deadline) {
    const job = await claimNext();
    if (!job) break;

    const handler = handlers[job.kind];
    try {
      if (!handler) throw new Error(`No handler for job kind "${job.kind}" yet.`);
      await handler(job);
    } catch (error) {
      if (processed > 0 && isSubrequestLimit(error)) {
        console.warn(`Job ${job.id} ran out of requests after ${processed} others; it goes first next run`);
        await requeue(job.id);
        break;
      }
      console.error(`Job ${job.id} (${job.kind}) failed`, error);
      await fail(job.id, error);
    }
    processed++;
  }

  await settleIfIdle().catch((error) => console.warn('Settling after imports failed', error));
  return processed;
}
