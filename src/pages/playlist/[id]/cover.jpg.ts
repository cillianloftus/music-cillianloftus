import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDefinition } from '../../../lib/definitions';

/** A playlist's own cover, when one was chosen. */
export const GET: APIRoute = async ({ params, request }) => {
  const saved = await getDefinition(params.id!);
  if (!saved?.art_key || saved.art_mode !== 'uploaded') return new Response('Not found', { status: 404 });
  const object = await env.ASSET_STORE.get(saved.art_key, { onlyIf: request.headers });
  if (!object) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', 'public, no-cache');
  if (!('body' in object)) return new Response(null, { status: 304, headers });
  return new Response(object.body, { headers });
};
