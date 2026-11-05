import type { APIRoute } from 'astro';
import { addRating, ratingFormFields, ratingInput, safeReturnPath } from '../../../lib/ratings';

/**
 * Appends a rating. A plain form post, so rating works before (and without)
 * any JavaScript; on success it returns to where the rating started.
 */
export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const user = locals.user!; // Guaranteed by middleware on /api/write.
  const form = Object.fromEntries(await request.formData());
  const parsed = ratingInput.safeParse(ratingFormFields(form));

  const ratePage =
    typeof form.entity_type === 'string' && typeof form.entity_id === 'string'
      ? `/edit/rate/${encodeURIComponent(form.entity_type)}/${encodeURIComponent(form.entity_id)}`
      : '/';

  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'That rating could not be saved.';
    const params = new URLSearchParams({ error: message });
    if (typeof form.return_to === 'string') params.set('return_to', form.return_to);
    return redirect(`${ratePage}?${params}`, 303);
  }

  try {
    await addRating(user.id, parsed.data);
  } catch (error) {
    console.error('Rating insert failed', error);
    return redirect(`${ratePage}?error=${encodeURIComponent('That rating could not be saved.')}`, 303);
  }

  return redirect(safeReturnPath(form.return_to, ratePage), 303);
};
