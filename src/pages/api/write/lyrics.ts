import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

/**
 * "Wrong lyrics" on Now playing: this LRCLIB entry is not this song's, so it
 * (and any entry with the same words) is never shown for it again (0081).
 */
export const POST: APIRoute = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as { recordingId?: unknown; lrclibId?: unknown } | null;
  const recordingId = typeof body?.recordingId === 'string' ? body.recordingId : '';
  const lrclibId = Number(body?.lrclibId);
  if (!recordingId || !Number.isSafeInteger(lrclibId) || lrclibId <= 0) {
    return Response.json({ ok: false, error: 'Which song and which lyrics?' }, { status: 400 });
  }
  const known = await env.DB.prepare(`SELECT 1 FROM recording WHERE id = ?`).bind(recordingId).first();
  if (!known) return Response.json({ ok: false, error: 'That song is not in the library.' }, { status: 404 });
  await env.DB.prepare(`INSERT INTO lyrics_rejected (recording_id, lrclib_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).bind(recordingId, lrclibId).run();
  return Response.json({ ok: true });
};
