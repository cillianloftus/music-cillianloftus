import type { APIRoute } from 'astro';
import { enqueue } from '../../../lib/jobs/queue';
import { runJobs } from '../../../lib/jobs/runner';

/** Runs a backup now, outside the daily schedule. */
export const POST: APIRoute = async ({ redirect, locals }) => {
  await enqueue('backup', {});
  locals.cfContext.waitUntil(runJobs({ budgetMs: 25_000 }));
  return redirect('/manage/backups', 303);
};
