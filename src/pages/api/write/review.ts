import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { storeCoverArt } from '../../../lib/import/coverart';
import { detectAnomalies, dismiss, linkAllVersions, linkWork, mergeMatchingAlbums, mergeMatchingTracks, ReviewError, same, skip } from '../../../lib/review';

/**
 * Review queue actions. Each is one person's decision about one item;
 * nothing here runs on its own. Form posts that return to the queue, or,
 * asked for JSON, a short answer so the page can drop the card in place.
 */
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const intent = form.get('intent');
  const id = form.get('id')?.toString() ?? '';
  const kind = form.get('kind')?.toString() ?? '';
  const json = request.headers.get('Accept')?.includes('application/json');
  const back = (params: Record<string, string>) => {
    if (json) return Response.json({ ok: !params.error, ...params }, { status: params.error ? 400 : 200 });
    const query = new URLSearchParams(kind ? { kind, ...params } : params);
    return redirect(`/manage/review?${query}`, 303);
  };

  try {
    switch (intent) {
      case 'detect': {
        const run = await detectAnomalies();
        return back({ done: 'detect', raised: String(run.raised), cleared: String(run.cleared) });
      }
      case 'same':
        await same(id);
        return back({ done: 'merge' });
      case 'skip':
        await skip(id);
        return back({ done: 'skip' });
      case 'dismiss':
        await dismiss(id);
        return back({ done: 'dismiss' });
      case 'merge_matching': {
        const run =
          kind === 'near_duplicate_release_group' ? mergeMatchingAlbums : kind === 'version_of_recording' ? linkAllVersions : mergeMatchingTracks;
        const { merged, left } = await run({ budgetMs: 20_000 });
        return back({ done: 'merge_matching', merged: String(merged), left: String(left) });
      }
      case 'link_work':
        await linkWork(id);
        return back({ done: 'link_work' });
      case 'refetch_art': {
        const target = await env.DB.prepare(
          `SELECT r.id AS release_id, r.mbid AS release_mbid, g.mbid AS group_mbid
           FROM anomaly a
           JOIN v_release_group_canonical c ON c.release_group_id = a.entity_a
           JOIN release r ON r.id = c.release_id
           JOIN release_group g ON g.id = c.release_group_id
           WHERE a.id = ? AND a.kind = 'missing_cover_art' AND a.status = 'open'`,
        )
          .bind(id)
          .first<{ release_id: string; release_mbid: string | null; group_mbid: string | null }>();
        if (!target?.release_mbid || !target.group_mbid) throw new ReviewError('This album is not from MusicBrainz, so there is nowhere to look.');
        const key = await storeCoverArt({ releaseId: target.release_id, releaseMbid: target.release_mbid, releaseGroupMbid: target.group_mbid });
        if (!key) throw new ReviewError('The Cover Art Archive still has nothing for this album.');
        await env.DB.prepare(`UPDATE anomaly SET status = 'resolved', resolution = 'art_found' WHERE id = ?`).bind(id).run();
        return back({ done: 'refetch_art' });
      }
      default:
        return back({ error: 'Unknown action.' });
    }
  } catch (error) {
    if (error instanceof ReviewError) return back({ error: error.message });
    console.error('Review action failed', error);
    return back({ error: 'That could not be done. Nothing was changed.' });
  }
};
