import type { APIRoute } from 'astro';
import { dumpDatabase } from '../../../lib/backup/dump';

/** A fresh backup, straight to the browser. Read-only: nothing is stored. */
export const GET: APIRoute = async () => {
  const backup = await dumpDatabase();
  const stamp = backup.created_at.replace(/[:.]/g, '-');
  return new Response(JSON.stringify(backup), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="music-backup-${stamp}.json"`,
      'Cache-Control': 'no-store',
    },
  });
};
