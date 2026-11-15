import type { APIRoute } from 'astro';
import { DiscographyError, KINDS, queueDiscography, queueSpotifyDiscography, resolveArtist, type Kind } from '../../../../lib/import/discography';
import { kickJobs } from '../../../../lib/jobs/runner';
import { createBatch, deleteBatch, PRIORITY, renameBatch } from '../../../../lib/jobs/queue';
import { getArtistDetails } from '../../../../lib/musicbrainz/client';
import { env } from 'cloudflare:workers';

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
    // Put first: ahead of whatever bulk imports are waiting (0071).
    const priority = form.get('first') === 'on' ? PRIORITY.asked : PRIORITY.bulk;
    // One batch on the Jobs page, named for the artist (0072): their page
    // here when they have one, their name from MusicBrainz otherwise.
    const here =
      artist.source === 'musicbrainz'
        ? await env.DB.prepare(`SELECT id, name FROM artist WHERE mbid = ?`).bind(artist.id).first<{ id: string; name: string }>()
        : null;
    if (here && !artist.name) artist.name = here.name;
    if (!artist.name && artist.source === 'musicbrainz') artist.name = (await getArtistDetails(artist.id).catch(() => null))?.name ?? '';
    const batch = await createBatch(artist.name || 'An artist', 'discography', here ? `/artist/${here.id}` : null);
    // Not on MusicBrainz: straight from Spotify, every release by its link.
    let result: Awaited<ReturnType<typeof queueDiscography>>;
    if (artist.source === 'spotify') {
      const fromSpotify = await queueSpotifyDiscography(artist.id, kinds, undefined, priority, batch);
      artist.name = fromSpotify.name;
      await renameBatch(batch, fromSpotify.name);
      result = fromSpotify;
    } else {
      result = await queueDiscography(artist.id, kinds, priority, batch);
    }
    if (result.queued.length) kickJobs(locals.cfContext);
    else await deleteBatch(batch);
    if (json) return Response.json({ artist, ...result }, { status: 202 });
    return redirect('/manage/jobs', 303);
  } catch (error) {
    const message = error instanceof DiscographyError ? error.message : 'MusicBrainz or Spotify could not be reached. Try again shortly.';
    if (!(error instanceof DiscographyError)) console.error('Discography failed', error);
    if (json) return Response.json({ error: message }, { status: 422 });
    return redirect(`/manage/import?${new URLSearchParams({ derror: message })}`, 303);
  }
};
