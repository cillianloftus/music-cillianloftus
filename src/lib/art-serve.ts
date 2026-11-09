/**
 * Serving stored pictures (covers, artist photos) from R2.
 *
 * A picture's address never changes what it shows: a cover found or
 * chosen again is stored under a new version (artKeyFor), and artist
 * photos are named by their content. So each response may be kept for a
 * year, by the browser and at Cloudflare's edge, and a page of eighty
 * covers costs eighty edge hits after the first view anywhere, not eighty
 * trips to storage.
 */

import { env } from 'cloudflare:workers';

export const FOREVER = 'public, max-age=31536000, immutable';

type WaitUntil = ((promise: Promise<unknown>) => void) | undefined;

/**
 * The edge's copy of this address, or the first of `keys` R2 holds, or
 * what `make` makes when none is stored yet; kept at the edge for next
 * time unless it says how long it may be kept itself (a stand-in).
 */
export async function servePicture(
  request: Request,
  keys: string[],
  waitUntil: WaitUntil,
  make?: () => Promise<Response | null>,
): Promise<Response> {
  const cache = (caches as unknown as { default: Cache }).default;
  // Answers a conditional request with a 304 itself.
  const hit = await cache.match(request).catch(() => undefined);
  if (hit) return hit;

  let response: Response | null = null;
  for (const key of keys) {
    const object = await env.ASSET_STORE.get(key);
    if (!object) continue;
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('ETag', object.httpEtag);
    response = new Response(object.body, { headers });
    break;
  }
  response ??= make ? await make() : null;
  if (!response) return new Response('Not found', { status: 404 });
  if (response.headers.has('Cache-Control')) return response;
  response.headers.set('Cache-Control', FOREVER);
  const stored = cache.put(new Request(request.url), response.clone()).catch((error) => console.warn('Picture cache put failed', error));
  if (waitUntil) waitUntil(stored);
  return response;
}

/** The request's waitUntil, as the Cloudflare adapter passes it. */
export function waitUntilOf(locals: unknown): WaitUntil {
  const ctx = (locals as { cfContext?: { waitUntil(p: Promise<unknown>): void } }).cfContext;
  return ctx ? (promise) => ctx.waitUntil(promise) : undefined;
}
