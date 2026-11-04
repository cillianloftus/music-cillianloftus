/**
 * Names in the library, offered as suggestions in the builder (and, later,
 * given to the language model so a mangled name can snap back to a real one).
 */

import { env } from 'cloudflare:workers';

export async function genreNames(): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT name FROM genre ORDER BY name').all<{ name: string }>();
  return results.map((r) => r.name);
}

export async function artistNames(limit = 2000): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT DISTINCT name FROM artist ORDER BY sort_name LIMIT ?')
    .bind(limit)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}
