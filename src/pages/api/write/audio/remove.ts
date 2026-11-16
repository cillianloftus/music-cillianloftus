import type { APIRoute } from 'astro';
import { ownerId } from '../../../../lib/auth/user';
import { removeAudio } from '../../../../lib/audio';

/**
 * Removes uploaded audio (one file, or an album's), freeing its space. The
 * files stay catalogued and the originals on Cillian's machine are not
 * touched. The owner's only.
 */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  if (!locals.user || locals.user.id !== (await ownerId())) return new Response(null, { status: 403 });
  const ids = (await request.formData()).getAll('id').map(String).slice(0, 500);
  const n = await removeAudio(ids);
  return redirect(`/manage/files?${new URLSearchParams({ done: n ? `Removed ${n} uploaded ${n === 1 ? 'file' : 'files'}.` : 'Nothing to remove.' })}`, 303);
};
