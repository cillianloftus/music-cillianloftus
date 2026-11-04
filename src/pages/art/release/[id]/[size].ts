import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ART_SIZES, artKeyFor } from '../../../../lib/import/coverart';

/**
 * Serves stored cover art derivatives from R2. If a size was never stored
 * (small originals have no 1200), falls back to the largest smaller one.
 */
export const GET: APIRoute = async ({ params, request }) => {
  const size = Number(params.size?.replace(/\.jpg$/, ''));
  if (!ART_SIZES.includes(size as (typeof ART_SIZES)[number]) || !params.id) {
    return new Response('Not found', { status: 404 });
  }

  const candidates = ART_SIZES.filter((s) => s <= size).reverse();
  for (const candidate of candidates) {
    const object = await env.ASSET_STORE.get(`${artKeyFor(params.id)}/${candidate}.jpg`, {
      onlyIf: request.headers,
    });
    if (!object) continue;

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('ETag', object.httpEtag);
    headers.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');

    // onlyIf matched the client's ETag: the body is omitted.
    if (!('body' in object)) return new Response(null, { status: 304, headers });
    return new Response(object.body, { headers });
  }

  return new Response('Not found', { status: 404 });
};
