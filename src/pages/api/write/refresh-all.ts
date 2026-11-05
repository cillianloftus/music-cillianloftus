import type { APIRoute } from 'astro';
import { runJobs } from '../../../lib/jobs/runner';
import { refreshEverything } from '../../../lib/refresh';

/** Queues the whole library for a fresh lookup; the jobs page shows it. */
export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const form = await request.formData();
  if (form.get('confirm') !== 'yes') return redirect('/manage/refresh', 303);
  await refreshEverything();
  locals.cfContext.waitUntil(runJobs({ budgetMs: 25_000 }));
  return redirect('/manage/jobs', 303);
};
