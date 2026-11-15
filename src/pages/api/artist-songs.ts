import type { APIRoute } from 'astro';
import { artistSongs } from '../../lib/import/manual';

/**
 * An artist's songs, for Add by hand's builder to search on the device
 * (src/components/ReleaseBuilder.astro). Signed in only: it is for building
 * releases, and a whole catalogue is not a public read.
 */
export const GET: APIRoute = async ({ url, locals }) => {
  if (!locals.user) return new Response(null, { status: 401 });
  const artist = url.searchParams.get('artist') ?? '';
  return Response.json({ songs: await artistSongs(artist) }, { headers: { 'cache-control': 'no-store' } });
};
