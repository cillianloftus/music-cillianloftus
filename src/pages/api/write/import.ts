import type { APIRoute } from 'astro';
import { enqueue } from '../../../lib/jobs/queue';
import { runJobs } from '../../../lib/jobs/runner';
import { parseMbInput } from '../../../lib/musicbrainz/input';

/**
 * Queues an import. The cron would pick it up within a minute; starting
 * the runner after responding makes a single album land in seconds.
 */
export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const form = await request.formData();
  const input = form.get('source')?.toString() ?? '';
  const target = parseMbInput(input);

  if (!target) {
    return redirect(`/edit/import?error=unrecognised&source=${encodeURIComponent(input)}`, 303);
  }

  await enqueue('import_release', { source: 'musicbrainz', target });
  locals.cfContext.waitUntil(runJobs({ budgetMs: 25_000 }));

  return redirect('/edit/jobs', 303);
};
