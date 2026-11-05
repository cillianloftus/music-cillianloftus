import type { APIRoute } from 'astro';
import { removeQueued, setQueuePaused } from '../../../../lib/jobs/queue';
import { runJobs } from '../../../../lib/jobs/runner';

/** Pause or resume the queue, or take one waiting job out of it. Back to the jobs page. */
export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const form = await request.formData();
  const intent = form.get('intent');
  if (intent === 'pause') await setQueuePaused(true);
  if (intent === 'resume') {
    await setQueuePaused(false);
    locals.cfContext.waitUntil(runJobs({ budgetMs: 25_000 }));
  }
  if (intent === 'remove') await removeQueued(form.get('id')?.toString() ?? '');
  return redirect('/manage/jobs', 303);
};
