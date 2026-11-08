import type { APIRoute } from 'astro';
import { addRating, ratingFormFields, ratingInput, safeReturnPath } from '../../../lib/ratings';

/**
 * Appends a rating. A plain form post, so rating works before (and without)
 * any JavaScript; on success it returns to where the rating started.
 * Saved as you go (src/lib/client/rating-autosave.ts) it asks for JSON
 * instead, and gets a small answer rather than a page.
 */
export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const user = locals.user!; // Guaranteed by middleware on /api/write.
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
  const form = Object.fromEntries(await request.formData());
  const parsed = ratingInput.safeParse(ratingFormFields(form));

  const ratePage =
    typeof form.entity_type === 'string' && typeof form.entity_id === 'string'
      ? `/edit/rate/${encodeURIComponent(form.entity_type)}/${encodeURIComponent(form.entity_id)}`
      : '/';

  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'That rating could not be saved.';
    if (wantsJson) return Response.json({ error: message }, { status: 400 });
    const params = new URLSearchParams({ error: message });
    if (typeof form.return_to === 'string') params.set('return_to', form.return_to);
    return redirect(`${ratePage}?${params}`, 303);
  }

  try {
    const id = await addRating(user.id, parsed.data);
    if (wantsJson) return Response.json({ id });
  } catch (error) {
    console.error('Rating insert failed', error);
    if (wantsJson) return Response.json({ error: 'That rating could not be saved.' }, { status: 500 });
    return redirect(`${ratePage}?error=${encodeURIComponent('That rating could not be saved.')}`, 303);
  }

  return redirect(safeReturnPath(form.return_to, ratePage), 303);
};
