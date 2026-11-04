import { env } from 'cloudflare:workers';
import { storeCoverArt } from '../import/coverart';
import { planFromMusicBrainz } from '../import/musicbrainz';
import { writePlan } from '../import/write';
import { pushDefinition } from '../spotify/push';
import { runBackup } from '../backup/store';
import { claimNext, complete, fail, type JobPayloads, type JobRow } from './queue';

async function importRelease(job: JobRow): Promise<void> {
  const payload = JSON.parse(job.payload_json) as JobPayloads['import_release'];
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
      await storeCoverArt({ releaseId: result.releaseId, releaseMbid, releaseGroupMbid });
    } catch (error) {
      console.warn('Cover art failed', error);
    }
  }

  await complete(job.id, { ...payload, result: { releaseGroupId: result.releaseGroupId } }, 1);
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

/**
 * Works through queued jobs until the queue is empty or the time budget is
 * spent. Jobs that fail are recorded with their error and left for a retry;
 * they never stop the jobs behind them.
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
      console.error(`Job ${job.id} (${job.kind}) failed`, error);
      await fail(job.id, error);
    }
    processed++;
  }

  return processed;
}
