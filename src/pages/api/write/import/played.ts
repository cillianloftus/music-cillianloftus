import type { APIRoute } from 'astro';
import { kickJobs } from '../../../../lib/jobs/runner';
import { startPlayedImport } from '../../../../lib/import/played';

/** Queues the albums of every song played but not in the library (import/played.ts); the batch page follows it. */
export const POST: APIRoute = async ({ redirect, locals }) => {
  const { batchId } = await startPlayedImport();
  if (!batchId) return redirect('/manage/history?played=none', 303);
  kickJobs(locals.cfContext);
  return redirect(`/manage/jobs/batch/${batchId}`, 303);
};
