import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getDefinition } from '../../../../lib/definitions';

const MAX_BYTES = 3 * 1024 * 1024;

/**
 * A playlist's cover: one chosen by hand (resized to a square JPEG in the
 * browser), or back to the art drawn from its contents.
 */
export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const form = await request.formData();
  const id = form.get('id')?.toString() ?? '';
  const saved = await getDefinition(id);
  if (!saved || saved.user_id !== locals.user?.id) return new Response('Not found', { status: 404 });
  const back = () => redirect(`/playlist/${id}`, 303);

  if (form.get('intent') === 'generated') {
    await env.DB.prepare(`UPDATE definition SET art_mode = 'generated', art_key = NULL WHERE id = ?`).bind(id).run();
    if (saved.art_key) await env.ASSET_STORE.delete(saved.art_key);
    return back();
  }
  const file = form.get('cover');
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_BYTES) return back();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) return back();
  const key = `art/playlist/${id}.jpg`;
  await env.ASSET_STORE.put(key, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
  await env.DB.prepare(`UPDATE definition SET art_mode = 'uploaded', art_key = ? WHERE id = ?`).bind(key, id).run();
  return back();
};
