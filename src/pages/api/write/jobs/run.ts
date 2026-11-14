import type { APIRoute } from 'astro';
import { kickJobs } from '../../../../lib/jobs/runner';

/** Works the queue now rather than at the next cron tick. */
export const POST: APIRoute = async ({ redirect, locals }) => {
  kickJobs(locals.cfContext);
  return redirect('/manage/jobs', 303);
};
