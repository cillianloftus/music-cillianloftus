import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDefinition } from '../../../../lib/definitions';
import { enqueue } from '../../../../lib/jobs/queue';
import { runJobs } from '../../../../lib/jobs/runner';
import { isSmallJpeg } from '../../../../lib/spotify/push';

/** Queues a push of a saved playlist to Spotify. Owner only. */
export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const form = await request.formData();
  const id = form.get('definition_id')?.toString() ?? '';
  const saved = await getDefinition(id);
  if (!saved) return new Response('Not found', { status: 404 });
  if (saved.user_id !== locals.user!.id) {
    return new Response('Only the owner can push this playlist.', { status: 403 });
  }

  // The cover, drawn by the browser from the generated SVG (Workers have no
  // canvas). Optional: without JavaScript the push goes up without one.
  const art = form.get('art');
  if (art instanceof File && isSmallJpeg(new Uint8Array(await art.arrayBuffer()))) {
    const key = `art/playlist/${saved.id}.jpg`;
    await env.ASSET_STORE.put(key, await art.arrayBuffer(), { httpMetadata: { contentType: 'image/jpeg' } });
    await env.DB.prepare(`UPDATE definition SET art_key = ? WHERE id = ?`).bind(key, saved.id).run();
  }

  await enqueue('spotify_push', { definitionId: saved.id });
  locals.cfContext.waitUntil(runJobs({ budgetMs: 25_000 }));
  return redirect(`/playlist/${saved.id}#spotify`, 303);
};

