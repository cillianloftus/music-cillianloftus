import type { APIRoute } from 'astro';
import { addCredit, editTrackTitle, removeCredit } from '../../../../lib/credits';
import { env } from 'cloudflare:workers';
import { EditError, editTrackGenres, spotifyLinkStatements } from '../../../../lib/edits';
import { deriveAlbumGenres } from '../../../../lib/genres';
import { fillCreditsFromGenius } from '../../../../lib/genius';

/** A track's title and credits, one change per post. Back to the edit page. */
export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const form = Object.fromEntries(await request.formData()) as Record<string, string>;
  const id = form.id ?? '';
  const userId = locals.user!.id;
  const back = (params: Record<string, string>) =>
    form.from === 'album' && form.album
      ? redirect(`/edit/album/${form.album}?${new URLSearchParams(params)}`, 303)
      : redirect(`/edit/track/${id}?${new URLSearchParams(params)}#credits`, 303);
  try {
    switch (form.intent) {
      case 'title':
      case 'details': {
        await editTrackTitle(userId, id, form.title ?? '');
        if (form.spotify !== undefined) {
          const statements = await spotifyLinkStatements(userId, 'recording', id, form.spotify);
          if (statements.length) await env.DB.batch(statements);
        }
        if (form.genres !== undefined) {
          await editTrackGenres(id, form.genres);
          await deriveAlbumGenres();
        }
        return redirect(`/track/${id}?edited=1`, 303);
      }
      case 'add_credit': {
        const { created } = await addCredit(userId, id, { role: form.role ?? '', name: form.who ?? '', credited_as: form.credited_as });
        return back({ done: created ? `Added, and “${form.who?.trim()}” is new to the library.` : 'Credit added.' });
      }
      case 'remove_credit':
        await removeCredit(userId, id, form.credit ?? '');
        return back({ done: 'Credit removed.' });
      case 'genius': {
        const report = await fillCreditsFromGenius({ albumId: form.album || undefined, budgetMs: 20_000 });
        return back({
          done:
            report.looked === 0
              ? 'Nothing to look up: every track here has a writer, or has edited credits.'
              : `Looked up ${report.looked}, found ${report.matched} on Genius, added ${report.added} ${report.added === 1 ? 'credit' : 'credits'}.`,
        });
      }
      default:
        return back({ error: 'Unknown action.' });
    }
  } catch (error) {
    if (error instanceof EditError) return back({ error: error.message });
    console.error('Track edit failed', error);
    return back({ error: 'That could not be saved.' });
  }
};
