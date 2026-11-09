import type { APIRoute } from 'astro';
import { deriveAlbumGenres } from '../../../../lib/genres';
import { batchCredit } from '../../../../lib/credits';
import { createEdition, newEdition } from '../../../../lib/editions';
import { findCover } from '../../../../lib/covers';
import { mergeAlbums } from '../../../../lib/merge';
import { ReviewError } from '../../../../lib/review';
import { editEdition, editionEdit, albumEdit, creditWriter, editAlbum, EditError } from '../../../../lib/edits';

/** Saves an album's details, or credits a writer across it. Back to the edit page. */
export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const data = await request.formData();
  const form = Object.fromEntries(data) as Record<string, string>;
  const tracks = data.getAll('track').map(String);
  const id = form.id ?? '';
  const back = (params: Record<string, string>) => redirect(`/edit/album/${id}?${new URLSearchParams(params)}`, 303);
  try {
    if (form.intent === 'batch_credit') {
      const n = await batchCredit(locals.user!.id, id, {
        recordingIds: tracks,
        role: form.role ?? '',
        name: form.who ?? '',
        mode: form.mode === 'remove' ? 'remove' : 'add',
      });
      return back({ done: `${form.mode === 'remove' ? 'Removed from' : 'Added to'} ${n} ${n === 1 ? 'track' : 'tracks'}.` });
    }
    if (form.intent === 'add_edition') {
      const parsed = newEdition.safeParse(form);
      if (!parsed.success) return back({ error: parsed.error.issues[0]?.message ?? 'Check the fields.' });
      const made = await createEdition(id, parsed.data);
      return back({
        done: `Edition added: ${made.matched} ${made.matched === 1 ? 'track' : 'tracks'} already on the album${made.created ? `, ${made.created} new` : ''}.`,
      });
    }
    if (form.intent === 'cover') {
      const found = await findCover(form.edition ?? '', { replace: true });
      return back(
        found
          ? { done: `Cover replaced, from ${found === 'spotify' ? 'Spotify' : found === 'itunes' ? 'Apple Music' : 'the Cover Art Archive'}.` }
          : { error: 'No cover of its own was found for that edition. The old one is kept.' },
      );
    }
    if (form.intent === 'edition') {
      const parsed = editionEdit.safeParse(form);
      if (!parsed.success) return back({ error: parsed.error.issues[0]?.message ?? 'Check the fields.' });
      await editEdition(locals.user!.id, id, parsed.data);
      return back({ done: `Saved ${parsed.data.edition_title}.` });
    }
    if (form.intent === 'fold') {
      if (!form.into) return back({ error: 'Choose the album it belongs to.' });
      await mergeAlbums(form.into, id);
      return redirect(`/album/${form.into}?edited=1`, 303);
    }
    if (form.intent === 'credit_writer') {
      const n = await creditWriter(id, form.writer ?? '');
      return back({ done: `Credited on ${n} ${n === 1 ? 'track' : 'tracks'}.` });
    }
    const parsed = albumEdit.safeParse(form);
    if (!parsed.success) return back({ error: parsed.error.issues[0]?.message ?? 'Check the fields.' });
    await editAlbum(locals.user!.id, id, parsed.data);
    // Albums that borrow their genres from this one's tracks follow at once.
    await deriveAlbumGenres();
    return redirect(`/album/${id}?edited=1`, 303);
  } catch (error) {
    if (error instanceof EditError || error instanceof ReviewError) return back({ error: error.message });
    console.error('Album edit failed', error);
    return back({ error: 'That could not be saved.' });
  }
};
