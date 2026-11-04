import type { APIRoute } from 'astro';
import { addPlays, playsRequest } from '../../../../lib/history';
import { describeIssues } from '../../../../lib/query/schema';

/** One batch of plays for the signed-in user. Already-held plays are skipped. */
export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user!; // Guaranteed by middleware on /api/write.
  const parsed = playsRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Unreadable plays.', details: describeIssues(parsed.error).slice(0, 5) }, { status: 422 });
  return Response.json({ added: await addPlays(user.id, parsed.data.plays) });
};
