import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ART_SIZES, artKeyFor } from '../../../../lib/import/coverart';

const MAX_BYTES = 3 * 1024 * 1024;
const isJpeg = (bytes: Uint8Array) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

/**
 * A cover chosen by hand for one edition. The page resizes it in the
 * browser to the stored widths (250, 500, 1200) as JPEG; without
 * JavaScript one JPEG arrives and stands in at every size. Marked as an
 * override so no lookup replaces it.
 */
export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const form = await request.formData();
  const id = form.get('id')?.toString() ?? '';
  const edition = form.get('edition')?.toString() ?? '';
  const back = (params: Record<string, string>) => redirect(`/edit/album/${id}?${new URLSearchParams(params)}`, 303);

  const owned = await env.DB.prepare(`SELECT 1 AS yes FROM release WHERE id = ? AND release_group_id = ?`).bind(edition, id).first();
  if (!owned) return back({ error: 'That edition is not one of this album’s.' });

  const files = new Map<number, Uint8Array>();
  for (const size of ART_SIZES) {
    const file = form.get(`s${size}`) ?? form.get('cover');
    if (!(file instanceof File) || file.size === 0) continue;
    if (file.size > MAX_BYTES) return back({ error: 'That image is too large. Under 3 MB, please.' });
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isJpeg(bytes)) return back({ error: 'Covers are stored as JPEG; choose a JPEG, or use a browser with JavaScript to convert it.' });
    files.set(size, bytes);
  }
  if (files.size === 0) return back({ error: 'Choose an image first.' });

  const key = artKeyFor(edition);
  const fallback = files.get(1200) ?? files.get(500) ?? files.get(250)!;
  await Promise.all(
    ART_SIZES.map((size) => env.ASSET_STORE.put(`${key}/${size}.jpg`, files.get(size) ?? fallback, { httpMetadata: { contentType: 'image/jpeg' } })),
  );
  await env.DB.batch([
    env.DB.prepare(`UPDATE release SET art_key = ? WHERE id = ?`).bind(key, edition),
    // Uploaded art cannot be put back, so the override has no original to return to.
    env.DB.prepare(
      `INSERT INTO field_override (entity_type, entity_id, field, value_json, user_id) VALUES ('release', ?, 'art_key', '"manual"', ?)
       ON CONFLICT (entity_type, entity_id, field) DO UPDATE SET user_id = excluded.user_id, edited_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ).bind(edition, locals.user!.id),
  ]);
  return back({ done: 'Cover saved. It can take a refresh to show everywhere.' });
};
