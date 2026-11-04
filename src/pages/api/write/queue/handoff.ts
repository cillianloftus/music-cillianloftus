import type { APIRoute } from 'astro';
import { recordHandoff } from '../../../../lib/queue';

/** Sent as a beacon when a queue item is opened in Spotify. */
export const POST: APIRoute = async ({ request, locals }) => {
  const form = await request.formData();
  const type = form.get('entity_type');
  const id = form.get('entity_id')?.toString();
  if ((type !== 'recording' && type !== 'release_group') || !id) {
    return new Response(null, { status: 400 });
  }
  await recordHandoff(locals.user!.id, type, id);
  return new Response(null, { status: 204 });
};
