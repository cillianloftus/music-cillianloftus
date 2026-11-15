import type { APIRoute } from 'astro';
import { markSame, markVersion, VersionError } from '../../../../lib/mark-versions';

/**
 * Marks two songs from a track's page: "version" (one song, sharing a
 * rating until each has its own) or "same" (one recording, merged). Back to
 * the track, or, asked for JSON, a short answer.
 */
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const id = form.get('id')?.toString() ?? '';
  const of = form.get('of')?.toString() ?? '';
  const intent = form.get('intent')?.toString();
  const json = request.headers.get('Accept')?.includes('application/json');
  try {
    let at = id;
    if (intent === 'version') await markVersion(id, of);
    else if (intent === 'same') at = await markSame(id, of);
    else return new Response('Unknown action.', { status: 400 });
    const done = intent === 'version' ? 'Marked as versions of one song.' : 'Merged into one recording.';
    // A merge may keep the other one: its page is the one to go back to.
    return json ? Response.json({ ok: true, href: `/track/${at}` }) : redirect(`/track/${at}?${new URLSearchParams({ done })}`, 303);
  } catch (error) {
    if (!(error instanceof VersionError)) throw error;
    return json
      ? Response.json({ ok: false, error: error.message }, { status: 400 })
      : redirect(`/track/${id}?${new URLSearchParams({ error: error.message })}`, 303);
  }
};
