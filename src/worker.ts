import { handle } from '@astrojs/cloudflare/handler';
import { enqueue } from './lib/jobs/queue';
import { runJobs } from './lib/jobs/runner';

/** Must match the daily entry in wrangler.jsonc triggers.crons. */
const DAILY_BACKUP = '0 4 * * *';

export default {
  fetch: handle,

  // Every minute: claim queued jobs and work through them. A scheduled
  // invocation may run for minutes, but stopping well inside the cron
  // interval keeps ticks from piling up behind each other.
  // Daily at 04:00 UTC: queue a backup first.
  async scheduled(controller, _env, ctx) {
    ctx.waitUntil(
      (async () => {
        if (controller.cron === DAILY_BACKUP) await enqueue('backup', {});
        await runJobs({ budgetMs: 50_000 });
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
