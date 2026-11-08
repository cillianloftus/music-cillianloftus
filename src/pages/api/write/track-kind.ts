import type { APIRoute } from 'astro';
import { isKind, setKind, skipSuggestion, TrackKindError } from '../../../lib/track-kinds';

/**
 * Marks a track as a song, interlude or skit, or puts its suggestion off.
 * A form post that returns where it came from, or JSON for the page that
 * drops the row in place.
 */
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const id = form.get('id')?.toString() ?? '';
  const kind = form.get('kind')?.toString();
  const back = form.get('back')?.toString() ?? '/manage/track-kinds';
  const json = request.headers.get('Accept')?.includes('application/json');
  const safeBack = back.startsWith('/') && !back.startsWith('//') ? back : '/manage/track-kinds';

  try {
    if (form.get('intent') === 'skip') await skipSuggestion(id);
    else if (isKind(kind)) await setKind(id, kind);
    else throw new TrackKindError('Choose song, interlude or skit.');
    return json ? Response.json({ ok: true }) : redirect(safeBack, 303);
  } catch (error) {
    if (!(error instanceof TrackKindError)) throw error;
    return json
      ? Response.json({ ok: false, error: error.message }, { status: 400 })
      : redirect(`${safeBack}${safeBack.includes('?') ? '&' : '?'}error=${encodeURIComponent(error.message)}`, 303);
  }
};
