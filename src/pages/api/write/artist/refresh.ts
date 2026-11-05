import type { APIRoute } from 'astro';
import { fetchArtistImages } from '../../../../lib/artist-images';
import { enrichArtist } from '../../../../lib/artists';

/** Looks an artist up again: details from MusicBrainz, pictures from Wikimedia and Spotify. */
export const POST: APIRoute = async ({ request, redirect }) => {
  const id = (await request.formData()).get('id')?.toString() ?? '';
  try {
    await enrichArtist(id);
    await fetchArtistImages(id);
    return redirect(`/artist/${id}?refreshed=1`, 303);
  } catch (error) {
    console.error('Artist refresh failed', error);
    return redirect(`/artist/${id}?refreshed=failed`, 303);
  }
};
