import type { APIRoute } from 'astro';
import { kickJobs } from '../../../../lib/jobs/runner';
import { refreshArtist } from '../../../../lib/refresh';

/**
 * Looks every album by an artist up again. With fetch (the artist page),
 * answers with the jobs so the corner tray follows them; a plain post goes
 * to the jobs page.
 */
export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const id = (await request.formData()).get('id')?.toString() ?? '';
  const albums = await refreshArtist(id);
  if (albums.length) kickJobs(locals.cfContext);
  if (request.headers.get('accept')?.includes('application/json')) {
    return Response.json({ albums: albums.map((a) => ({ title: a.title, jobs: a.jobs })) }, { status: 202 });
  }
  return redirect('/manage/jobs', 303);
};
