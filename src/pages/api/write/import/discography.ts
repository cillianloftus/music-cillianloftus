import type { APIRoute } from 'astro';
import { DiscographyError, KINDS, queueDiscography, resolveArtist, type Kind } from '../../../../lib/import/discography';
import { runJobs } from '../../../../lib/jobs/runner';

/**
 * Queues an artist's discography. With fetch (the import and artist pages)
 * it answers with the jobs so the corner tray follows them; otherwise it
 * goes to the jobs page.
 */
export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const form = await request.formData();
  const json = request.headers.get('accept')?.includes('application/json');
  const kinds = new Set(
    form
      .getAll('kind')
      .map(String)
      .filter((k): k is Kind => Object.hasOwn(KINDS, k)),
  );
  try {
    if (kinds.size === 0) throw new DiscographyError('Tick at least one kind of release.');
    const artist = await resolveArtist(form.get('artist')?.toString() ?? '');
    const result = await queueDiscography(artist.id, kinds);
    if (result.queued.length) locals.cfContext.waitUntil(runJobs({ budgetMs: 25_000 }));
    if (json) return Response.json({ artist, ...result }, { status: 202 });
    return redirect('/manage/jobs', 303);
  } catch (error) {
    const message = error instanceof DiscographyError ? error.message : 'MusicBrainz could not be reached. Try again shortly.';
    if (!(error instanceof DiscographyError)) console.error('Discography failed', error);
    if (json) return Response.json({ error: message }, { status: 422 });
    return redirect(`/manage/import?${new URLSearchParams({ derror: message })}`, 303);
  }
};
