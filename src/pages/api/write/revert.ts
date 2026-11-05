import type { APIRoute } from 'astro';
import { EditError } from '../../../lib/edits';
import { parseRevert, revertEdit } from '../../../lib/revert';

/** Undo on an "Edited" mark: back to the page it came from. */
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const referer = request.headers.get('referer');
  const page = referer && new URL(referer).origin === new URL(request.url).origin ? new URL(referer) : new URL('/manage', request.url);
  page.searchParams.delete('error');
  page.searchParams.delete('done');
  try {
    const { entity, id, field } = parseRevert(form.get('revert')?.toString() ?? '');
    await revertEdit(entity, id, field);
    page.searchParams.set('done', 'Edit undone.');
  } catch (error) {
    if (!(error instanceof EditError)) console.error('Revert failed', error);
    page.searchParams.set('error', error instanceof EditError ? error.message : 'That could not be undone.');
  }
  return redirect(`${page.pathname}${page.search}`, 303);
};
