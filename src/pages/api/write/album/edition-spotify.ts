import type { APIRoute } from 'astro';
import { spotifyFor } from '../../../../lib/spotify/client';
import { findEditionOnSpotify } from '../../../../lib/spotify/link';

/**
 * An edition's own Spotify album, found when Listen is pressed on it and it
 * has none yet (src/lib/spotify/link.ts): its id, kept, so the button plays
 * it now and every time after. { spotifyId: null } when Spotify has no match.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });
  const form = await request.formData();
  const release = form.get('release')?.toString() ?? '';
  try {
    const spotifyId = await findEditionOnSpotify(spotifyFor(user.id), release);
    return Response.json({ spotifyId });
  } catch (error) {
    console.warn('Finding an edition on Spotify failed', error);
    return Response.json({ spotifyId: null }, { status: 502 });
  }
};
