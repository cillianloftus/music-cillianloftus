import type { APIRoute } from 'astro';
import { addParent, createGenre, GenreError, moveGenre, removeParent } from '../../../lib/genres';

/**
 * Edits the genre tree: move a genre (beneath another, or to the top
 * level) or add one. Plain form posts back to /manage/genres, keeping the
 * suggestions open if they were.
 */
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const text = (name: string) => form.get(name)?.toString() ?? '';
  const keep = form.get('suggest') === '1' ? '&suggest=1' : '';
  const back = (params: string, anchor = '') => redirect(`/manage/genres?${params}${keep}${anchor}`, 303);

  try {
    if (text('intent') === 'add_parent') {
      await addParent(text('id'), text('parent'));
      return back(`done=moved`, `#genre-${text('id')}`);
    }
    if (text('intent') === 'remove_parent') {
      await removeParent(text('id'), text('parent_id'));
      return back(`done=moved`, `#genre-${text('id')}`);
    }
    if (text('intent') === 'create_and_move') {
      // A Wikidata suggestion not yet in the library: add it, then place beneath it.
      await createGenre(text('name'), null);
      await moveGenre(text('id'), text('name'));
      return back(`done=moved`, `#genre-${text('id')}`);
    }
    if (text('intent') === 'create') {
      const id = await createGenre(text('name'), text('parent') || null);
      return back(`done=created`, `#genre-${id}`);
    }
    const id = text('id');
    await moveGenre(id, text('parent') || null);
    return back(`done=moved`, `#genre-${id}`);
  } catch (error) {
    if (error instanceof GenreError) return back(`error=${encodeURIComponent(error.message)}`);
    console.error('Genre edit failed', error);
    return back(`error=${encodeURIComponent('That could not be saved.')}`);
  }
};
