import type { APIRoute } from 'astro';
import { ownerId } from '../../lib/auth/user';
import { playPrefer, playQueue, queueSources } from '../../lib/play-queue';

/**
 * The songs a Play button asks for (?album, ?track, ?playlist), from your
 * own files: for the player that keeps going between pages
 * (src/lib/client/local-player.ts). The owner's only.
 */
export const GET: APIRoute = async ({ url, locals }) => {
  if (!locals.user || locals.user.id !== (await ownerId())) return Response.json({ error: 'Sign in to play your files.' }, { status: 403 });
  const sources = await queueSources(locals.user.id);
  const [found, prefer] = await Promise.all([playQueue(url.searchParams, sources), playPrefer()]);
  // Spotify first only means anything with Spotify connected.
  return Response.json({ ...found, prefer: sources.spotify ? prefer : 'file' }, { headers: { 'cache-control': 'private, no-store' } });
};
