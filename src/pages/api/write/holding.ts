import type { APIRoute } from 'astro';
import { addHolding, holdingInput, removeHolding } from '../../../lib/holdings';

/** Adds or removes an owned edition. A plain form post back to the album. */
export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const user = locals.user!; // Guaranteed by middleware on /api/write.
  const form = Object.fromEntries(await request.formData());
  const back = (albumId: string | null, params = '') => redirect(albumId ? `/album/${albumId}${params}#editions-heading` : '/', 303);

  if (form.intent === 'remove') {
    return back(typeof form.id === 'string' ? await removeHolding(user.id, form.id) : null);
  }

  const albumId = typeof form.album_id === 'string' ? form.album_id : null;
  const parsed = holdingInput.safeParse({ release_id: form.release_id, format: form.format, acquired: form.acquired, notes: form.notes });
  if (!parsed.success) {
    return back(albumId, `?holding_error=${encodeURIComponent(parsed.error.issues[0]?.message ?? 'That could not be saved.')}`);
  }
  return back((await addHolding(user.id, parsed.data)) ?? albumId);
};
