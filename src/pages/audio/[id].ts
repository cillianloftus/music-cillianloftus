import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ownerId } from '../../lib/auth/user';

/**
 * One of your audio files, to the player (/play): the owner's only, signed
 * in, never cached by anyone else. Byte ranges are answered (206), so the
 * player can seek and the browser can stream rather than download it all.
 */
export const GET: APIRoute = async ({ params, request, locals }) => {
  if (!locals.user || locals.user.id !== (await ownerId())) return new Response(null, { status: 403 });
  const file = await env.DB.prepare(`SELECT audio_key, audio_bytes FROM file WHERE id = ? AND audio_key IS NOT NULL`)
    .bind(params.id ?? '')
    .first<{ audio_key: string; audio_bytes: number }>();
  if (!file) return new Response('Not found', { status: 404 });

  const size = file.audio_bytes;
  const wanted = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
  let range: { offset: number; length: number } | undefined;
  if (wanted && (wanted[1] || wanted[2])) {
    // "bytes=100-", "bytes=100-199", or the last n: "bytes=-500".
    const start = wanted[1] ? Number(wanted[1]) : Math.max(0, size - Number(wanted[2]));
    const end = wanted[1] && wanted[2] ? Math.min(Number(wanted[2]), size - 1) : size - 1;
    if (start >= size || end < start) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    range = { offset: start, length: end - start + 1 };
  }
  const object = await env.AUDIO_STORE.get(file.audio_key, range ? { range } : undefined);
  if (!object) return new Response('Not found', { status: 404 });
  const headers = new Headers({
    'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
    // Only this browser keeps it: the file is the owner's, behind sign-in.
    'cache-control': 'private, max-age=86400',
  });
  if (range) {
    headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
    headers.set('content-length', String(range.length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set('content-length', String(size));
  return new Response(object.body, { headers });
};
