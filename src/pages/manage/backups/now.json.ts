import type { APIRoute } from 'astro';
import { backupText } from '../../../lib/backup/dump';

/**
 * A fresh backup, straight to the browser, gzipped as it is made: never
 * whole in memory, which the library outgrew (see dump.ts). Read-only:
 * nothing is stored. The same file the nightly backup writes to R2.
 */
export const GET: APIRoute = async () => {
  const { created_at, pieces } = await backupText();
  const encoder = new TextEncoder();
  const text = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      const { value, done } = await pieces.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(value));
    },
  });
  const stamp = created_at.replace(/[:.]/g, '-');
  return new Response(text.pipeThrough(new CompressionStream('gzip') as ReadableWritablePair<Uint8Array, Uint8Array<ArrayBuffer>>), {
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="music-backup-${stamp}.json.gz"`,
      'Cache-Control': 'no-store',
    },
  });
};
