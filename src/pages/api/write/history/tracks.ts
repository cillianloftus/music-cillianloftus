import type { APIRoute } from 'astro';
import { addTracks, tracksRequest } from '../../../../lib/history';
import { describeIssues } from '../../../../lib/query/schema';

/** Keeps a batch of tracks from a streaming-history export; answers how many are in the catalogue. */
export const POST: APIRoute = async ({ request }) => {
  const parsed = tracksRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Unreadable tracks.', details: describeIssues(parsed.error).slice(0, 5) }, { status: 422 });
  return Response.json({ matched: await addTracks(parsed.data.tracks) });
};
