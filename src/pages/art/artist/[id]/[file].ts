import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

/** Serves a stored artist picture from R2. */
export const GET: APIRoute = async ({ params, request }) => {
  const file = params.file ?? '';
  if (!/^[0-9a-f]{16}\.jpg$/.test(file) || !/^[0-9a-f-]{1,64}$/i.test(params.id ?? '')) {
    return new Response('Not found', { status: 404 });
  }
  const object = await env.ASSET_STORE.get(`art/artist/${params.id}/${file}`, { onlyIf: request.headers });
  if (!object) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  if (!('body' in object)) return new Response(null, { status: 304, headers });
  return new Response(object.body, { headers });
};
