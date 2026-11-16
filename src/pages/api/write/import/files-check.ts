import type { APIRoute } from 'astro';
import { albumCandidates, albumQuestion, type Candidate } from '../../../../lib/import/files';

/**
 * Before an import from files writes anything: for each album read from
 * the folder, the albums already in the library it might be, for Cillian
 * to confirm or turn down (src/lib/import/files.ts, albumCandidates).
 * Reads only.
 */
export const POST: APIRoute = async ({ request }) => {
  const parsed = albumQuestion.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Those albums could not be read.' }, { status: 400 });
  const candidates: Record<string, Candidate[]> = {};
  for (const album of parsed.data.albums) candidates[album.key] = await albumCandidates(album);
  return Response.json({ candidates });
};
