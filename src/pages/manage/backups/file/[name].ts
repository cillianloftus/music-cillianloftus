import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { BACKUP_PREFIX } from '../../../../lib/backup/store';

/** Downloads a stored daily backup from R2. */
export const GET: APIRoute = async ({ params }) => {
  const name = params.name ?? '';
  if (!/^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(name)) return new Response('Not found', { status: 404 });

  const object = await env.ASSET_STORE.get(`${BACKUP_PREFIX}${name}`);
  if (!object) return new Response('Not found', { status: 404 });

  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="music-backup-${name}"`,
      'Cache-Control': 'no-store',
    },
  });
};
