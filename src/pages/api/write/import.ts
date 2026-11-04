import type { APIRoute } from 'astro';
import { enqueue } from '../../../lib/jobs/queue';
import { runJobs } from '../../../lib/jobs/runner';
import { parseMbInput } from '../../../lib/musicbrainz/input';
import { parseSpotifyInput } from '../../../lib/spotify/album';

/**
 * Queues an import. The cron would pick it up within a minute; starting
 * the runner after responding makes a single album land in seconds.
 */
export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const form = await request.formData();
  const input = form.get('source')?.toString() ?? '';
  const target = parseMbInput(input);
  const spotify = target ? null : parseSpotifyInput(input);

  if (target) {
    await enqueue('import_release', { source: 'musicbrainz', target });
  } else if (spotify) {
    await enqueue('import_release', { source: 'spotify', target: spotify });
  } else {
    return redirect(`/edit/import?error=unrecognised&source=${encodeURIComponent(input)}`, 303);
  }
  locals.cfContext.waitUntil(runJobs({ budgetMs: 25_000 }));

  return redirect('/edit/jobs', 303);
};
