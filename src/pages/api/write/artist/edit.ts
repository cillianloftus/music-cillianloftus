import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { mergeArtists } from '../../../../lib/merge';
import { ReviewError } from '../../../../lib/review';
import { setFirstImage, setImageOrder } from '../../../../lib/artist-images';
import { addAlias, addLink, artistEdit, editArtist, EditError, removeAlias, removeLink, setImageHidden } from '../../../../lib/edits';

/** Artist details, other names, links between artists, and which pictures show. */
export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const form = Object.fromEntries(await request.formData()) as Record<string, string>;
  const id = form.id ?? '';
  const back = (params: Record<string, string>) => redirect(`/edit/artist/${id}?${new URLSearchParams(params)}`, 303);
  try {
    switch (form.intent) {
      case 'add_alias':
        await addAlias(id, form.alias ?? '');
        return back({ done: 'Name added.' });
      case 'remove_alias':
        await removeAlias(id, form.alias ?? '');
        return back({ done: 'Name removed.' });
      case 'add_link': {
        const kind = form.kind === 'has_member' || form.kind === 'same_person' ? form.kind : 'member_of';
        await addLink(id, kind, form.other ?? '');
        return back({ done: 'Linked.' });
      }
      case 'remove_link':
        await removeLink(id, form.other_id ?? '', form.kind ?? '');
        return back({ done: 'Unlinked.' });
      case 'merge': {
        // A duplicate of this artist, by name: folded into this one (its
        // credits, names, pictures and links move here; its page redirects).
        const name = (form.other ?? '').trim();
        if (!name) return back({ error: 'Name the duplicate to merge in.' });
        const { results } = await env.DB.prepare(
          `SELECT DISTINCT a.id, a.name FROM artist a LEFT JOIN artist_alias x ON x.artist_id = a.id
           WHERE a.id <> ?2 AND (a.name = ?1 COLLATE NOCASE OR x.name = ?1 COLLATE NOCASE)`,
        )
          .bind(name, id)
          .all<{ id: string; name: string }>();
        if (results.length === 0) return back({ error: `No other artist is called “${name}”.` });
        if (results.length > 1) return back({ error: `More than one other artist is called “${name}”. Merge from one of their pages instead.` });
        await mergeArtists(id, results[0]!.id);
        return back({ done: `Merged “${results[0]!.name}” into this artist.` });
      }
      case 'image_order': {
        const keys = JSON.parse(form.order ?? '[]') as unknown;
        if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string')) return back({ error: 'That order could not be read.' });
        await setImageOrder(locals.user!.id, id, keys as string[]);
        if (request.headers.get('accept')?.includes('application/json')) return Response.json({ ok: true });
        return back({ done: 'Order saved.' });
      }
      case 'first_image':
        await setFirstImage(locals.user!.id, id, form.key ?? '');
        return back({ done: 'That picture comes first now.' });
      case 'hide_image':
      case 'show_image':
        await setImageHidden(id, form.key ?? '', form.intent === 'hide_image');
        return back({ done: form.intent === 'hide_image' ? 'Picture hidden.' : 'Picture shown.' });
      default: {
        const parsed = artistEdit.safeParse(form);
        if (!parsed.success) return back({ error: parsed.error.issues[0]?.message ?? 'Check the fields.' });
        await editArtist(locals.user!.id, id, parsed.data);
        return redirect(`/artist/${id}?edited=1`, 303);
      }
    }
  } catch (error) {
    if (error instanceof EditError || error instanceof ReviewError) return back({ error: error.message });
    console.error('Artist edit failed', error);
    return back({ error: 'That could not be saved.' });
  }
};
