import type { APIRoute } from 'astro';
import { EditError } from '../../../lib/edits';
import { editRole, moveKeyRole, removeRole, setKeyRole } from '../../../lib/credits';

/** Credit role settings: key or not, key order, name and kind, removal. */
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = Object.fromEntries(await request.formData()) as Record<string, string>;
  const id = form.id ?? '';
  const back = (params: Record<string, string> = {}) => redirect(`/manage/roles?${new URLSearchParams(params)}#role-${id}`, 303);
  try {
    switch (form.intent) {
      case 'key':
        await setKeyRole(id, true);
        return back();
      case 'unkey':
        await setKeyRole(id, false);
        return back();
      case 'up':
        await moveKeyRole(id, -1);
        return back();
      case 'down':
        await moveKeyRole(id, 1);
        return back();
      case 'edit':
        await editRole(id, form.label ?? '', form.family ?? '');
        return back({ done: 'Saved.' });
      case 'remove':
        await removeRole(id);
        return back({ done: 'Role removed.' });
      default:
        return back({ error: 'Unknown action.' });
    }
  } catch (error) {
    if (error instanceof EditError) return back({ error: error.message });
    console.error('Role edit failed', error);
    return back({ error: 'That could not be saved.' });
  }
};
