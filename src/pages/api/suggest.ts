import type { APIRoute } from 'astro';
import { hueOf } from '../../lib/art/playlist';
import { ownerId } from '../../lib/auth/user';
import { lovedArtists, lovedGenres } from '../../lib/home';
import { byLibrary } from '../../lib/library-cache';
import { recentRatings } from '../../lib/overview';

/**
 * What the search panel shows before anything is typed: the latest
 * ratings, the artists and genres rated highest. Kept per library state,
 * so opening search costs no database reads until the library changes.
 */
export const GET: APIRoute = async ({ locals }) => {
  const viewerId = locals.user?.id ?? (await ownerId());
  const [recent, artists, genres] = await byLibrary('suggest:v2', viewerId, () =>
    Promise.all([recentRatings(viewerId, 40), lovedArtists(viewerId, 10), lovedGenres(viewerId, 12)]),
  );
  // Tracks rated off one album show as that album, once.
  const seen = new Set<string>();
  const lately = recent
    .map((r) =>
      r.album_id
        ? { key: r.album_id, href: `/album/${r.album_id}`, title: r.album_title ?? r.title, art: r.art_key }
        : { key: r.entity_id, href: `/track/${r.entity_id}`, title: r.title, art: r.art_key },
    )
    .filter((r) => !seen.has(r.key) && seen.add(r.key))
    .slice(0, 10);
  return Response.json(
    {
      recent: lately.map(({ href, title, art }) => ({ href, title, art })),
      artists: artists.map((a) => ({ href: `/artist/${a.id}`, title: a.name, image: a.image_key, art: a.art_key })),
      genres: genres.map((g) => ({ href: `/genre/${g.id}`, title: g.name, hue: hueOf(g.name) })),
    },
    { headers: { 'cache-control': 'private, max-age=300' } },
  );
};
