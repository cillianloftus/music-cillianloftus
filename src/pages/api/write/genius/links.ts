import type { APIRoute } from 'astro';
import { fillSongLinks } from '../../../../lib/genius';

/**
 * One round of looking up samples and interpolations for tracks already
 * matched on Genius (the nightly run does the same, a little at a time).
 * Answers with what it did and how many are left, so it can be called
 * until none are.
 */
export const POST: APIRoute = async () => {
  const report = await fillSongLinks({ budgetMs: 25_000, limit: 120 });
  return Response.json(report);
};
