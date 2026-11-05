import type { APIRoute } from 'astro';
import { retry, retryAllFailed } from '../../../../lib/jobs/queue';
import { runJobs } from '../../../../lib/jobs/runner';

export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const form = await request.formData();
  const id = form.get('id')?.toString();
  const retried = form.get('all') === '1' ? (await retryAllFailed()) > 0 : Boolean(id && (await retry(id)));
  if (retried) locals.cfContext.waitUntil(runJobs({ budgetMs: 25_000 }));
  return redirect('/manage/jobs', 303);
};
