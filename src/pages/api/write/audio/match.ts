import type { APIRoute } from 'astro';
import { z } from 'zod';
import { ownerId } from '../../../../lib/auth/user';
import { AUDIO_FORMATS, matchFiles } from '../../../../lib/audio';

/**
 * Which library song each of your files is (src/lib/audio.ts, matchFiles):
 * the upload page sends what it read from the tags, never the audio.
 * The owner's only.
 */
// Tags are whatever a file happens to hold: a value that makes no sense
// (a zero length, a 900-character title, an upper-case id) is dropped, so
// one odd file never fails the rest of the folder.
const nullableText = z.string().trim().max(500).nullable().catch(null);
const payload = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(1000),
        checksum: z.string().toLowerCase().regex(/^[0-9a-f]{64}$/).nullable().catch(null),
        format: z.enum(Object.keys(AUDIO_FORMATS) as [keyof typeof AUDIO_FORMATS, ...(keyof typeof AUDIO_FORMATS)[]]).catch('mp3'),
        title: nullableText,
        artist: nullableText,
        albumArtist: nullableText,
        album: nullableText,
        lengthMs: z.number().int().positive().nullable().catch(null),
        mbRecordingId: z.string().toLowerCase().regex(/^[0-9a-f-]{36}$/).nullable().catch(null),
      }),
    )
    .min(1)
    .max(2000),
});

export const POST: APIRoute = async ({ request, locals }) => {
  if (!locals.user || locals.user.id !== (await ownerId())) return new Response(null, { status: 403 });
  const parsed = payload.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Those files could not be read (more than 2,000 at once, or a path over 1,000 characters).' }, { status: 400 });
  return Response.json({ matches: await matchFiles(parsed.data.files) });
};
