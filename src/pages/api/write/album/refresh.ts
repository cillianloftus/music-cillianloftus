import type { APIRoute } from 'astro';
import { runJobs } from '../../../../lib/jobs/runner';
import { refreshAlbum } from '../../../../lib/refresh';

/** Looks an album up again at its sources; the jobs page shows progress. */
export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const id = (await request.formData()).get('id')?.toString() ?? '';
  const queued = await refreshAlbum(id);
  if (queued.length === 0) {
    return redirect(`/edit/album/${id}?${new URLSearchParams({ error: 'This album was entered by hand, so there is nowhere to look it up.' })}`, 303);
  }
  locals.cfContext.waitUntil(runJobs({ budgetMs: 25_000 }));
  return redirect('/manage/jobs', 303);
};
