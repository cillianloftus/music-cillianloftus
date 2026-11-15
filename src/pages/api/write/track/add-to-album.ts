import type { APIRoute } from 'astro';
import { addToAlbum, AddToAlbumError } from '../../../../lib/add-to-album';

/** Puts a song on an album from the song's page (add-to-album.ts). To the album, or JSON when asked. */
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const id = form.get('id')?.toString() ?? '';
  const album = form.get('album')?.toString() ?? '';
  const raw = Number(form.get('position')?.toString() || '');
  const json = request.headers.get('Accept')?.includes('application/json');
  try {
    await addToAlbum(id, album, Number.isFinite(raw) && raw > 0 ? raw : null);
    return json ? Response.json({ ok: true, href: `/album/${album}` }) : redirect(`/album/${album}`, 303);
  } catch (error) {
    if (!(error instanceof AddToAlbumError)) throw error;
    return json
      ? Response.json({ ok: false, error: error.message }, { status: 400 })
      : redirect(`/track/${id}?${new URLSearchParams({ error: error.message })}`, 303);
  }
};
