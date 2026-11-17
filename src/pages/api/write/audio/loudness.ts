import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { ownerId } from '../../../../lib/auth/user';

/**
 * How loud files uploaded before loudness was measured are (0082), sent
 * when their folder is imported again: by path, or by checksum (the same
 * file uploaded from another folder). The player
 * turns loud ones down to Spotify's level. The owner's only.
 */
const payload = z.object({
  files: z.array(z.object({ path: z.string().min(1).max(1000), checksum: z.string().regex(/^[0-9a-f]{64}$/).nullable().catch(null), lufs: z.number().gt(-70).lt(5) })).max(500),
});

export const POST: APIRoute = async ({ request, locals }) => {
  if (!locals.user || locals.user.id !== (await ownerId())) return new Response(null, { status: 403 });
  const parsed = payload.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Not a list of files and their loudness.' }, { status: 400 });
  if (parsed.data.files.length === 0) return Response.json({ updated: 0 });
  const result = await env.DB.prepare(
    `UPDATE file SET loudness_lufs = j.value ->> '$.lufs'
     FROM json_each(?1) j
     WHERE (file.path = j.value ->> '$.path' OR file.checksum = j.value ->> '$.checksum') AND file.audio_key IS NOT NULL`,
  )
    .bind(JSON.stringify(parsed.data.files))
    .run();
  return Response.json({ updated: result.meta.changes ?? 0 });
};
