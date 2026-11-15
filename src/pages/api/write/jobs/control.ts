import type { APIRoute } from 'astro';
import { prioritiseBatch, promote, removeBatchQueued, removeQueued, setQueuePaused } from '../../../../lib/jobs/queue';
import { kickJobs } from '../../../../lib/jobs/runner';
import { safeReturnPath } from '../../../../lib/ratings';

/**
 * Steering the queue: pause or resume it; one waiting job taken out or
 * moved to the front; a whole batch (a discography, a refresh) put first,
 * sent back in line, or its waiting jobs taken out (0072). Back to the page
 * it was asked from.
 */
export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const form = await request.formData();
  const intent = form.get('intent');
  const id = form.get('id')?.toString() ?? '';
  const batch = form.get('batch')?.toString() ?? '';
  if (intent === 'pause') await setQueuePaused(true);
  if (intent === 'resume') {
    await setQueuePaused(false);
    kickJobs(locals.cfContext);
  }
  if (intent === 'first') {
    await promote([id]);
    kickJobs(locals.cfContext);
  }
  if (intent === 'remove') await removeQueued(id);
  if (intent === 'batch-first' && batch) {
    await prioritiseBatch(batch, true);
    kickJobs(locals.cfContext);
  }
  if (intent === 'batch-in-line' && batch) await prioritiseBatch(batch, false);
  if (intent === 'batch-remove' && batch) await removeBatchQueued(batch);
  return redirect(safeReturnPath(form.get('back'), '/manage/jobs'), 303);
};
