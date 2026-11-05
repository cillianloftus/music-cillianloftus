import type { APIRoute } from 'astro';
import { skip } from '../../../../lib/queue';

export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const form = await request.formData();
  const type = form.get('entity_type');
  const id = form.get('entity_id')?.toString();
  if ((type !== 'recording' && type !== 'release_group') || !id) {
    return new Response('Bad request', { status: 400 });
  }
  await skip(locals.user!.id, type, id);
  return redirect('/queue', 303);
};
