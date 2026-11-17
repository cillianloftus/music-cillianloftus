import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ownerId } from '../../../../lib/auth/user';
import { AUDIO_FORMATS, MAX_AUDIO_BYTES, storeAudio, type AudioFormat } from '../../../../lib/audio';

/**
 * One audio file, its bytes as the body (PUT), for a song already matched
 * (match.ts): what it is goes in the query. Streamed to the private bucket,
 * never held whole. The owner's only.
 */
export const PUT: APIRoute = async ({ request, url, locals }) => {
  if (!locals.user || locals.user.id !== (await ownerId())) return new Response(null, { status: 403 });
  const recordingId = url.searchParams.get('recording') ?? '';
  const path = url.searchParams.get('path') ?? '';
  const format = url.searchParams.get('format') ?? '';
  const checksum = url.searchParams.get('checksum');
  const size = Number(request.headers.get('content-length'));
  if (!(format in AUDIO_FORMATS)) return Response.json({ error: 'Not an audio format the player knows.' }, { status: 400 });
  if (!path || path.length > 1000) return Response.json({ error: 'No file path.' }, { status: 400 });
  if (checksum !== null && !/^[0-9a-f]{64}$/.test(checksum)) return Response.json({ error: 'A bad checksum.' }, { status: 400 });
  if (!Number.isFinite(size) || size <= 0) return Response.json({ error: 'The file arrived without its size.' }, { status: 411 });
  if (size > MAX_AUDIO_BYTES) return Response.json({ error: 'Over 100 MB: too large to upload in one piece.' }, { status: 413 });
  if (!request.body) return Response.json({ error: 'No audio arrived.' }, { status: 400 });
  const known = await env.DB.prepare(`SELECT 1 AS yes FROM recording WHERE id = ?`).bind(recordingId).first();
  if (!known) return Response.json({ error: 'That song is not in the library.' }, { status: 404 });
  const id = await storeAudio({ recordingId, path, format: format as AudioFormat, checksum, size, body: request.body });
  // Its loudness, measured in the browser before sending (0082): the player levels it with Spotify.
  const lufs = Number(url.searchParams.get('lufs'));
  if (url.searchParams.has('lufs') && Number.isFinite(lufs) && lufs > -70 && lufs < 5) {
    await env.DB.prepare(`UPDATE file SET loudness_lufs = ? WHERE id = ?`).bind(lufs, id).run();
  }
  return Response.json({ id });
};
