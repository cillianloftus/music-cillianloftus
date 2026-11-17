import type { APIRoute } from 'astro';
import { ownerId } from '../../lib/auth/user';
import { playQueue } from '../../lib/play-queue';

/**
 * The songs a Play button asks for (?album, ?track, ?playlist), from your
 * own files: for the player that keeps going between pages
 * (src/lib/client/local-player.ts). The owner's only.
 */
export const GET: APIRoute = async ({ url, locals }) => {
  if (!locals.user || locals.user.id !== (await ownerId())) return Response.json({ error: 'Sign in to play your files.' }, { status: 403 });
  return Response.json(await playQueue(url.searchParams), { headers: { 'cache-control': 'private, no-store' } });
};
