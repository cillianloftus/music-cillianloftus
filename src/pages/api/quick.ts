import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

/**
 * What a long-press needs to offer its quick actions (QuickActions.astro):
 * a song's or album's title, its Spotify id (for Play and Add to queue),
 * the album a song is on, and whether it is rated by gut only. Signed in
 * only, like the actions themselves. A few seeks: it runs on every press.
 */
export const GET: APIRoute = async ({ url, locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });
  const kind = url.searchParams.get('kind');
  const id = url.searchParams.get('id') ?? '';
  const headers = { 'cache-control': 'no-store' };

  if (kind === 'track') {
    const row = await env.DB.prepare(
      `SELECT r.title, r.spotify_id,
              (SELECT x.release_group_id FROM track t JOIN release x ON x.id = t.release_id JOIN release_group g ON g.id = x.release_group_id
               WHERE t.recording_id = r.id ORDER BY g.type <> 'album', g.first_release_date LIMIT 1) AS album_id,
              (SELECT depth FROM rating WHERE entity_type = 'recording' AND entity_id = r.id AND user_id = ?2 ORDER BY rated_at DESC LIMIT 1) AS depth
       FROM recording r WHERE r.id = ?1`,
    )
      .bind(id, user.id)
      .first<{ title: string; spotify_id: string | null; album_id: string | null; depth: string | null }>();
    if (!row) return new Response(null, { status: 404 });
    return Response.json({ kind, id, title: row.title, spotifyId: row.spotify_id, albumId: row.album_id, depth: row.depth }, { headers });
  }

  if (kind === 'album') {
    const row = await env.DB.prepare(
      `SELECT g.title, g.spotify_id,
              (SELECT depth FROM rating WHERE entity_type = 'release_group' AND entity_id = g.id AND user_id = ?2 ORDER BY rated_at DESC LIMIT 1) AS depth
       FROM release_group g WHERE g.id = ?1`,
    )
      .bind(id, user.id)
      .first<{ title: string; spotify_id: string | null; depth: string | null }>();
    if (!row) return new Response(null, { status: 404 });
    return Response.json({ kind, id, title: row.title, spotifyId: row.spotify_id, albumId: null, depth: row.depth }, { headers });
  }

  return new Response(null, { status: 400 });
};
