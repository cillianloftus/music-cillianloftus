import type { APIRoute } from 'astro';
import { addCredit, addRole, removeCredit, removeRole, type CreditTarget } from '../../../lib/credits';
import { EditError } from '../../../lib/edits';

/** Adds or removes one credit on a track or an album; back to where it came from. */
export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const form = Object.fromEntries(await request.formData()) as Record<string, string>;
  const entity: CreditTarget = form.entity === 'release_group' ? 'release_group' : 'recording';
  const id = form.id ?? '';
  const page = entity === 'release_group' ? `/edit/album/${id}` : `/edit/track/${id}`;
  const back = (params: Record<string, string>) => redirect(`${page}?${new URLSearchParams(params)}#credits`, 303);
  try {
    if (form.intent === 'add_credit') {
      const { created } = await addCredit(locals.user!.id, id, { role: form.role ?? '', name: form.who ?? '', credited_as: form.credited_as }, entity);
      return back({ done: created ? `Added, and “${form.who?.trim()}” is new to the library.` : 'Credit added.' });
    }
    if (form.intent === 'add_role') {
      await addRole(form.label ?? '', form.family ?? '');
      return back({ done: `“${form.label?.trim()}” is now a role you can credit.` });
    }
    if (form.intent === 'remove_role') {
      await removeRole(form.role ?? '');
      return back({ done: 'Role removed.' });
    }
    if (form.intent === 'remove_credit') {
      await removeCredit(locals.user!.id, id, form.credit ?? '', entity);
      return back({ done: 'Credit removed.' });
    }
    return back({ error: 'Unknown action.' });
  } catch (error) {
    if (error instanceof EditError) return back({ error: error.message });
    console.error('Credit edit failed', error);
    return back({ error: 'That could not be saved.' });
  }
};
