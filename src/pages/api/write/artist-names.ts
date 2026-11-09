import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { byLibrary } from '../../../lib/library-cache';

/**
 * Every artist name and other name, for the credit editor's suggestions.
 * Fetched when a name field is first used, rather than written into every
 * edit page (6,000 options, and 15,000 rows read each time the page was
 * loaded or refreshed after adding a credit). Kept until the library
 * changes; the browser keeps it a few minutes across edit pages.
 */
export const GET: APIRoute = async () => {
  const names = await byLibrary('artist-names:v1', null, async () =>
    (await env.DB.prepare(`SELECT name FROM artist UNION SELECT name FROM artist_alias ORDER BY 1`).all<{ name: string }>()).results.map(
      (r) => r.name,
    ),
  );
  return Response.json(names, { headers: { 'cache-control': 'private, max-age=600' } });
};
