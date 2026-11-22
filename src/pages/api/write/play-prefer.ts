import type { APIRoute } from 'astro';
import { setPlayPrefer } from '../../../lib/play-queue';

/** Which plays a song both uploaded and on Spotify (play-queue.ts playPrefer). */
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  await setPlayPrefer(form.get('prefer') === 'file' ? 'file' : 'spotify');
  if (request.headers.get('accept')?.includes('application/json')) return Response.json({ ok: true });
  return redirect('/manage#group-playing', 303);
};
