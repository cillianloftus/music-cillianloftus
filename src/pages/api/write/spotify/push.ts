import type { APIRoute } from 'astro';
import { getDefinition } from '../../../../lib/definitions';
import { enqueue } from '../../../../lib/jobs/queue';
import { runJobs } from '../../../../lib/jobs/runner';

/** Queues a push of a saved playlist to Spotify. Owner only. */
export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const form = await request.formData();
  const id = form.get('definition_id')?.toString() ?? '';
  const saved = await getDefinition(id);
  if (!saved) return new Response('Not found', { status: 404 });
  if (saved.user_id !== locals.user!.id) {
    return new Response('Only the owner can push this playlist.', { status: 403 });
  }

  await enqueue('spotify_push', { definitionId: saved.id });
  locals.cfContext.waitUntil(runJobs({ budgetMs: 25_000 }));
  return redirect(`/playlist/${saved.id}#spotify`, 303);
};
