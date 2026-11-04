import type { APIRoute } from 'astro';
import { OAUTH_PATH, STATE_COOKIE, connect, redirectUriFor } from '../../../../lib/spotify/client';

/** Spotify sends the user back here after they approve (or decline) access. */
export const GET: APIRoute = async ({ url, cookies, redirect, locals }) => {
  const expected = cookies.get(STATE_COOKIE)?.value;
  cookies.delete(STATE_COOKIE, { path: OAUTH_PATH });

  const error = url.searchParams.get('error');
  if (error) return redirect(`/edit/spotify?error=${encodeURIComponent(error)}`, 303);

  // The state ties this callback to a connect request from this browser.
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!expected || state !== expected || !code) return redirect('/edit/spotify?error=state', 303);

  try {
    await connect(locals.user!.id, code, redirectUriFor(url));
  } catch (cause) {
    console.error('Spotify connect failed', cause);
    return redirect('/edit/spotify?error=exchange', 303);
  }
  return redirect('/edit/spotify?connected=1', 303);
};
