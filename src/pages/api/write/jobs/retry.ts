import type { APIRoute } from 'astro';
import { retry } from '../../../../lib/jobs/queue';
import { runJobs } from '../../../../lib/jobs/runner';

export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const form = await request.formData();
  const id = form.get('id')?.toString();
  if (id && (await retry(id))) {
    locals.cfContext.waitUntil(runJobs({ budgetMs: 25_000 }));
  }
  return redirect('/edit/jobs', 303);
};
