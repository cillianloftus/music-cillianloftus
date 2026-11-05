import type { APIRoute } from 'astro';
import { OAUTH_PATH, STATE_COOKIE, authorizeUrl, isConfigured, redirectUriFor } from '../../../../lib/spotify/client';

/** Starts Spotify authorisation. */
export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  if (!isConfigured()) return redirect('/manage/spotify?error=not-configured', 303);

  // Spotify rejects "localhost" redirect URIs; loopback must be an IP
  // literal. Move to 127.0.0.1 first so the state cookie lands on that host.
  if (url.hostname === 'localhost') {
    const loopback = new URL(url);
    loopback.hostname = '127.0.0.1';
    return redirect(loopback.toString(), 302);
  }

  const state = crypto.randomUUID();
  cookies.set(STATE_COOKIE, state, {
    path: OAUTH_PATH,
    httpOnly: true,
    sameSite: 'lax',
    secure: url.protocol === 'https:',
    maxAge: 600,
  });
  return redirect(authorizeUrl(redirectUriFor(url), state), 302);
};
