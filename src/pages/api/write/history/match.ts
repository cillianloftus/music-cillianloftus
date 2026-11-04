import type { APIRoute } from 'astro';
import { matchRequest, matchTracks } from '../../../../lib/history';
import { describeIssues } from '../../../../lib/query/schema';

/** Which tracks from a streaming-history export are in the catalogue. Reads only. */
export const POST: APIRoute = async ({ request }) => {
  const parsed = matchRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Unreadable tracks.', details: describeIssues(parsed.error).slice(0, 5) }, { status: 422 });
  return Response.json({ matches: await matchTracks(parsed.data.tracks) });
};
