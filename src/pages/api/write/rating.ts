import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
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
    if (wantsJson) {
      // The score it makes now, for the page to show without reloading.
      const { entity_type: type, entity_id: entity } = parsed.data;
      const score = await env.DB.prepare(
        type === 'recording'
          ? 'SELECT quality_score AS quality, personal_score AS personal FROM v_recording_score WHERE recording_id = ? AND user_id = ?'
          : 'SELECT quality_score AS quality, personal_score AS personal FROM v_release_score WHERE release_group_id = ? AND user_id = ?',
      )
        .bind(entity, user.id)
        .first<{ quality: number | null; personal: number | null }>()
        .catch(() => null);
      return Response.json({ id, quality: score?.quality ?? null, personal: score?.personal ?? null });
    }
  } catch (error) {
    console.error('Rating insert failed', error);
    if (wantsJson) return Response.json({ error: 'That rating could not be saved.' }, { status: 500 });
    return redirect(`${ratePage}?error=${encodeURIComponent('That rating could not be saved.')}`, 303);
  }

  return redirect(safeReturnPath(form.return_to, ratePage), 303);
};
