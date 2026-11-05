import type { APIRoute } from 'astro';
import { ownerId } from '../../lib/auth/user';
import { MIN_QUERY_LENGTH, search } from '../../lib/search';

/**
 * Search results for the overlay, as small JSON: a few artists, albums and
 * tracks with what each row shows. Public, like the pages it links to.
 */
export const GET: APIRoute = async ({ url, locals }) => {
  const q = url.searchParams.get('q')?.trim() ?? '';
  const canImport = Boolean(locals.user);
  if (q.length < MIN_QUERY_LENGTH) return Response.json({ q, canImport, artists: [], albums: [], tracks: [] });
  const viewerId = locals.user?.id ?? (await ownerId());
  const found = await search(q, viewerId);
  const by = (credits: { name: string }[]) => credits.map((c) => c.name).join(', ');
  return Response.json(
    {
      q,
      canImport,
      artists: found.artists.slice(0, 4).map((a) => ({ href: `/artist/${a.id}`, title: a.name, detail: `${a.releases} ${a.releases === 1 ? 'release' : 'releases'}`, art: a.art_key })),
      albums: found.albums.slice(0, 5).map((a) => ({
        href: `/album/${a.id}`,
        title: a.title,
        detail: [by(a.credits), a.first_release_date?.slice(0, 4)].filter(Boolean).join(' · '),
        art: a.art_key,
        score: a.quality_score == null ? null : Math.round(a.quality_score),
      })),
      tracks: found.tracks.slice(0, 6).map((t) => ({
        href: `/track/${t.id}`,
        title: t.title,
        detail: [by(t.credits), t.album_title].filter(Boolean).join(' · '),
        art: t.art_key,
        score: t.quality_score == null ? null : Math.round(t.quality_score),
      })),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
};
