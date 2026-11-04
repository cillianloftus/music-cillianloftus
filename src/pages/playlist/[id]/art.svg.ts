import type { APIRoute } from 'astro';
import { artItems } from '../../../lib/art/inputs';
import { playlistArtSvg } from '../../../lib/art/playlist';
import { getDefinition } from '../../../lib/definitions';

/** The playlist's generated art, drawn from what it currently holds. */
export const GET: APIRoute = async ({ params }) => {
  const saved = await getDefinition(params.id!);
  if (!saved) return new Response('Not found', { status: 404 });
  const svg = playlistArtSvg(await artItems(saved));
  return new Response(svg, {
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      // Ratings move the art, so it is only briefly cacheable.
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });
};
