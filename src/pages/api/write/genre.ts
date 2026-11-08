import type { APIRoute } from 'astro';
import { addParent, createGenre, GenreError, moveGenre, removeParent, renameGenre } from '../../../lib/genres';
import { dismissSuggestion } from '../../../lib/genre-suggest';

/**
 * Edits the genre tree: move a genre (beneath another, or to the top
 * level), add one, or take up or turn down a suggested parent. Plain form
 * posts come back to /manage/genres, keeping the Wikidata suggestions open
 * if they were; a request asking for JSON gets { ok, error } instead, so
 * the suggestions list can act without reloading.
 */
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const text = (name: string) => form.get(name)?.toString() ?? '';
  const all = (name: string) => form.getAll(name).map(String).filter(Boolean);
  const json = request.headers.get('accept')?.includes('application/json');
  const keep = form.get('suggest') === '1' ? '&suggest=1' : '';
  const back = (params: string, anchor = '') =>
    json ? Response.json({ ok: !params.startsWith('error=') }) : redirect(`/manage/genres?${params}${keep}${anchor}`, 303);
  const anchor = (id: string) => (text('next') ? `#s-${text('next')}` : `#genre-${id}`);

  /**
   * Files a genre under parents by name, the first as its primary parent
   * unless it already has one. Parents not yet in the library are added.
   */
  const fileUnder = async (id: string, parents: string[], placed: boolean) => {
    for (const [i, name] of parents.entries()) {
      try {
        await createGenre(name, null);
      } catch (error) {
        // Already a genre: the usual case.
        if (!(error instanceof GenreError) || !error.message.includes('already')) throw error;
      }
      if (i === 0 && !placed) await moveGenre(id, name);
      else await addParent(id, name);
    }
  };

  try {
    switch (text('intent')) {
      case 'rename': {
        const kept = await renameGenre(text('id'), text('name'));
        // From the genre's own page: back there (the kept genre's, after a merge).
        if (text('from') === 'genre' && !json) return redirect(`/genre/${kept}`, 303);
        return back(kept === text('id') ? `done=renamed` : `done=merged`, `#genre-${kept}`);
      }
      case 'add_parent':
        await addParent(text('id'), text('parent'));
        return back(`done=moved`, `#genre-${text('id')}`);
      case 'remove_parent':
        await removeParent(text('id'), text('parent_id'));
        return back(`done=moved`, `#genre-${text('id')}`);
      case 'create_and_move':
        // A Wikidata suggestion not yet in the library: add it, then place beneath it.
        await createGenre(text('name'), null);
        await moveGenre(text('id'), text('name'));
        return back(`done=moved`, `#genre-${text('id')}`);
      case 'create': {
        const id = await createGenre(text('name'), text('parent') || null);
        return back(`done=created`, `#genre-${id}`);
      }
      case 'file_under':
        await fileUnder(text('id'), all('parent'), text('placed') === '1');
        return back(`done=moved`, anchor(text('id')));
      case 'dismiss':
        for (const name of all('parent')) await dismissSuggestion(text('id'), name);
        return back(`done=dismissed`, anchor(text('id')));
      case 'file_all': {
        // Each "id|parent|parent…"; one that the database refuses (a cycle
        // formed by two placements together) is left for later.
        let filed = 0;
        for (const place of all('place')) {
          const [id, ...parents] = place.split('|');
          try {
            await fileUnder(id, parents, false);
            filed++;
          } catch (error) {
            if (!(error instanceof GenreError)) throw error;
          }
        }
        return back(`done=filed&n=${filed}`, '#suggest-heading');
      }
      default: {
        const id = text('id');
        await moveGenre(id, text('parent') || null);
        return back(`done=moved`, `#genre-${id}`);
      }
    }
  } catch (error) {
    const message = error instanceof GenreError ? error.message : 'That could not be saved.';
    if (!(error instanceof GenreError)) console.error('Genre edit failed', error);
    return json ? Response.json({ ok: false, error: message }, { status: 400 }) : back(`error=${encodeURIComponent(message)}`);
  }
};
