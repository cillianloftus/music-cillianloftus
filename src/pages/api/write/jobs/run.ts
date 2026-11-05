import type { APIRoute } from 'astro';
import { runJobs } from '../../../../lib/jobs/runner';

/** Works the queue now rather than at the next cron tick. */
export const POST: APIRoute = async ({ redirect, locals }) => {
  locals.cfContext.waitUntil(runJobs({ budgetMs: 25_000 }));
  return redirect('/manage/jobs', 303);
};
