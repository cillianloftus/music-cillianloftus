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

  // The import page posts with fetch and keeps the person on the page,
  // watching the job in a small tray; a plain form post goes to the jobs page.
  const wantsJson = request.headers.get('accept')?.includes('application/json');
  let jobId: string;
  if (target) {
    jobId = await enqueue('import_release', { source: 'musicbrainz', target });
  } else if (spotify) {
    jobId = await enqueue('import_release', { source: 'spotify', target: spotify });
  } else {
    if (wantsJson) return Response.json({ error: 'That is not a MusicBrainz or Spotify album link.' }, { status: 422 });
    return redirect(`/manage/import?error=unrecognised&source=${encodeURIComponent(input)}`, 303);
  }
  locals.cfContext.waitUntil(runJobs({ budgetMs: 25_000 }));

  if (wantsJson) return Response.json({ jobId, label: target ? 'MusicBrainz release' : 'Spotify album' }, { status: 202 });
  return redirect('/manage/jobs', 303);
};
