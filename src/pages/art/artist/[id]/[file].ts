import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { servePicture, waitUntilOf } from '../../../../lib/art-serve';
import { PICTURE_WIDTHS } from '../../../../lib/pictures';

/**
 * Serves a stored artist picture from R2: the original (`<name>.jpg`), or a
 * WebP of it at one of PICTURE_WIDTHS (`<name>-320.webp`), made the first
 * time it is asked for and kept beside the original, which is never
 * touched. Named for where the picture came from and never written over,
 * so every address shows one image for good.
 */
export const GET: APIRoute = ({ params, request, locals }) => {
  const file = params.file ?? '';
  const id = params.id ?? '';
  if (!/^[0-9a-f-]{1,64}$/i.test(id)) return new Response('Not found', { status: 404 });
  const original = /^([0-9a-f]{16})\.jpg$/.exec(file);
  if (original) return servePicture(request, [`art/artist/${id}/${file}`], waitUntilOf(locals));
  const sized = /^([0-9a-f]{16})-(\d+)\.webp$/.exec(file);
  const width = Number(sized?.[2]);
  if (!sized || !PICTURE_WIDTHS.includes(width as (typeof PICTURE_WIDTHS)[number])) return new Response('Not found', { status: 404 });
  const base = `art/artist/${id}/${sized[1]}`;
  return servePicture(request, [`${base}-${width}.webp`], waitUntilOf(locals), () => makeSized(base, width));
};

/** A WebP of the picture at `width` wide, never enlarged, stored for next time; the original when resizing fails. */
async function makeSized(base: string, width: number): Promise<Response | null> {
  const source = await env.ASSET_STORE.get(`${base}.jpg`);
  if (!source) return null;
  try {
    const made = await env.IMAGES.input(source.body).transform({ width, fit: 'scale-down' }).output({ format: 'image/webp', quality: 80 });
    const bytes = await new Response(made.image()).arrayBuffer();
    await env.ASSET_STORE.put(`${base}-${width}.webp`, bytes, { httpMetadata: { contentType: 'image/webp' } });
    return new Response(bytes, { headers: { 'Content-Type': 'image/webp' } });
  } catch (error) {
    console.warn('Artist picture resize failed', base, width, error);
    const again = await env.ASSET_STORE.get(`${base}.jpg`);
    return again ? new Response(again.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' } }) : null;
  }
}
