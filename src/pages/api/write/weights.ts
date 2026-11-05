import type { APIRoute } from 'astro';
import { activateVersion, saveWeights, weightsForm } from '../../../lib/weights';

/**
 * Saves the weights on the form as a new active version, or makes an
 * earlier version active again. Plain form posts; both return to the
 * weights page.
 */
export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const user = locals.user!; // Guaranteed by middleware on /api/write.
  const form = Object.fromEntries(await request.formData());

  if (form.intent === 'activate') {
    const ok = typeof form.id === 'string' && (await activateVersion(user.id, form.id));
    return redirect(ok ? '/manage/weights?saved=activated' : '/manage/weights?error=version', 303);
  }

  const parsed = weightsForm.safeParse(form);
  if (!parsed.success) {
    const params = new URLSearchParams(Object.entries(form).filter((e): e is [string, string] => typeof e[1] === 'string'));
    params.delete('intent');
    params.set('error', parsed.error.issues[0]?.message ?? 'Those weights could not be saved.');
    return redirect(`/manage/weights?${params}`, 303);
  }
  const version = await saveWeights(user.id, parsed.data);
  return redirect(`/manage/weights?saved=${version}`, 303);
};
