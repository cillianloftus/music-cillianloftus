import type { APIRoute } from 'astro';
import { z } from 'zod';
import { ReauthorizationRequired, SpotifyNotConfigured, spotifyFor } from '../../../lib/spotify/client';
import { control, nowPlaying, PlayerError, type PlayerCommand } from '../../../lib/spotify/player';

/**
 * Now playing, for the signed-in listener: GET is what Spotify is playing,
 * POST a command (play, pause, next, previous, seek, shuffle, repeat, or
 * start a track or album). Behind Access like every /api/write route.
 * Spotify only, no database beyond the token: polled every few seconds.
 */

const spotifyId = z.string().regex(/^[A-Za-z0-9]{22}$/);
const command = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['play', 'pause', 'next', 'previous']) }),
  z.object({ action: z.literal('seek'), positionMs: z.number().int().min(0).max(24 * 3_600_000) }),
  z.object({ action: z.literal('shuffle'), on: z.boolean() }),
  z.object({ action: z.literal('repeat'), mode: z.enum(['off', 'track', 'context']) }),
  z
    .object({ action: z.literal('start'), track: spotifyId.optional(), album: spotifyId.optional() })
    .refine((c) => c.track || c.album, 'A track or an album to start.'),
]);

function failure(error: unknown): Response {
  if (error instanceof PlayerError) return Response.json({ error: error.message, reason: error.reason }, { status: 409 });
  if (error instanceof ReauthorizationRequired || error instanceof SpotifyNotConfigured) {
    return Response.json({ error: 'Connect Spotify on Manage › Spotify first.', reason: 'scope' }, { status: 409 });
  }
  console.error('Player failed', error);
  return Response.json({ error: 'Spotify could not be reached.', reason: 'other' }, { status: 502 });
}

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });
  try {
    return Response.json(await nowPlaying(spotifyFor(user.id)), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return failure(error);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });
  const parsed = command.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Not a command this player knows.' }, { status: 400 });
  try {
    const client = spotifyFor(user.id);
    await control(client, parsed.data as PlayerCommand);
    // Spotify takes a moment to change track; the page polls again shortly.
    return Response.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
};
