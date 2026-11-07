import type { APIRoute } from 'astro';
import { keepUnofficial, removeReleaseGroup, removeUnofficial, RemovalError } from '../../../lib/official';

/**
 * Unofficial releases: remove one, remove a batch, or keep one. "Remove
 * all" goes a batch at a time; the page asks again (Accept: JSON) until
 * nothing is left, and without JavaScript each press does one batch.
 */
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const intent = form.get('intent')?.toString();
  const id = form.get('id')?.toString() ?? '';
  const json = request.headers.get('Accept')?.includes('application/json');
  const reply = (body: Record<string, unknown>, params: Record<string, string>) =>
    json ? Response.json({ ok: true, ...body }) : redirect(`/manage/unofficial?${new URLSearchParams(params)}`, 303);

  try {
    switch (intent) {
      case 'remove':
        await removeReleaseGroup(id, 'unofficial');
        return reply({}, { done: 'removed' });
      case 'remove_not_wanted': {
        // From an album's own page: anything Cillian does not count, official or not.
        await removeReleaseGroup(id, 'not_wanted');
        return json ? Response.json({ ok: true }) : redirect('/manage/unofficial?done=removed', 303);
      }
      case 'keep':
        await keepUnofficial(id);
        return reply({}, { done: 'kept' });
      case 'remove_all': {
        const { removed, left } = await removeUnofficial({ budgetMs: 20_000 });
        return reply({ removed, left }, { done: 'batch', removed: String(removed), left: String(left) });
      }
      default:
        return new Response('Unknown action.', { status: 400 });
    }
  } catch (error) {
    if (!(error instanceof RemovalError)) throw error;
    return json
      ? Response.json({ ok: false, error: error.message }, { status: 400 })
      : redirect(`/manage/unofficial?${new URLSearchParams({ error: error.message })}`, 303);
  }
};
