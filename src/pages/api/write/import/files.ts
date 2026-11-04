import type { APIRoute } from 'astro';
import { describeIssues } from '../../../../lib/query/schema';
import { filesPayload, importFiles } from '../../../../lib/import/files';
import { runJobs } from '../../../../lib/jobs/runner';

/**
 * Adds albums from local audio tags. JSON in (tags, paths and checksums,
 * read in the browser; never audio), a report per album out.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Expected JSON.' }, { status: 400 });
  }
  const parsed = filesPayload.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'Those tags could not be read.', details: describeIssues(parsed.error).slice(0, 10) }, { status: 422 });
  }

  try {
    const albums = await importFiles(parsed.data);
    // Albums tagged by MusicBrainz were queued; start on them now.
    if (albums.some((a) => a.status === 'queued')) locals.cfContext.waitUntil(runJobs({ budgetMs: 25_000 }));
    return Response.json({ albums });
  } catch (error) {
    console.error('Import from files failed', error);
    return Response.json({ error: 'The import failed part-way. Albums already added stay added; run it again to finish.' }, { status: 500 });
  }
};
