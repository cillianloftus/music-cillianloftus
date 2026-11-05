import type { APIRoute } from 'astro';
import { spotifyFor } from '../../../../lib/spotify/client';
import { linkAlbumsToSpotify } from '../../../../lib/spotify/link';

/** Finds Spotify links for albums that have none. */
export const POST: APIRoute = async ({ redirect, locals }) => {
  try {
    const report = await linkAlbumsToSpotify(spotifyFor(locals.user!.id), { limit: 25 });
    const params = new URLSearchParams({ linked: String(report.albums), tracks: String(report.tracks) });
    if (report.missed.length) params.set('missed', report.missed.slice(0, 5).join(' · '));
    return redirect(`/manage/spotify?${params}`, 303);
  } catch (error) {
    console.error('Spotify linking failed', error);
    return redirect('/manage/spotify?error=link', 303);
  }
};
