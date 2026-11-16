import type { APIRoute } from 'astro';
import { z } from 'zod';
import { ownerId } from '../../../../lib/auth/user';
import { logLocalPlay } from '../../../../lib/audio';

/**
 * A listen on the player (/play): when it started and how long was heard.
 * Logged like any other play (audio.ts, logLocalPlay); sent by the player
 * when a song ends, is skipped, or the tab is left (sendBeacon). The
 * owner's only.
 */
const payload = z.object({
  recordingId: z.string().min(1).max(64),
  playedAt: z.string().datetime(),
  msPlayed: z.number().int().nonnegative().max(24 * 3_600_000),
});

export const POST: APIRoute = async ({ request, locals }) => {
  if (!locals.user || locals.user.id !== (await ownerId())) return new Response(null, { status: 403 });
  const parsed = payload.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Not a listen.' }, { status: 400 });
  const logged = await logLocalPlay(locals.user.id, parsed.data.recordingId, parsed.data.playedAt, parsed.data.msPlayed);
  return Response.json({ logged });
};
