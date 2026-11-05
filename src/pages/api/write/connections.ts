import type { APIRoute } from 'astro';
import { checkConnection } from '../../../lib/connection-check';
import { forget, saveCredentials, service, type ServiceId } from '../../../lib/connections';
import { syncScrobbles } from '../../../lib/scrobbles';

/**
 * /manage/connections: save a pasted key (and try it at once), try again,
 * forget it, or sync scrobbles now. Answers by going back to the page with
 * what happened.
 */
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const id = form.get('service')?.toString() ?? '';
  const def = service(id);
  if (!def) return new Response('Unknown service', { status: 400 });
  const back = (result: Record<string, string>) => redirect(`/manage/connections?${new URLSearchParams({ service: id, ...result })}#${id}`, 303);

  switch (form.get('intent')) {
    case 'save': {
      const input = Object.fromEntries(def.fields.map((f) => [f.key, form.get(f.key)?.toString() ?? '']));
      const problems = await saveCredentials(def.id, input);
      if (Object.keys(problems).length) return back({ error: Object.values(problems).join(' ') });
      const result = await checkConnection(def.id);
      return back(result.ok ? { ok: result.detail } : { error: result.detail });
    }
    case 'check': {
      const result = await checkConnection(def.id);
      return back(result.ok ? { ok: result.detail } : { error: result.detail });
    }
    case 'forget':
      await forget(def.id);
      return back({ ok: `Forgot the pasted ${def.name} details.` });
    case 'sync': {
      if (def.id !== 'lastfm' && def.id !== 'listenbrainz') return back({ error: 'Nothing to sync.' });
      try {
        const report = await syncScrobbles(def.id as Extract<ServiceId, 'lastfm' | 'listenbrainz'>, { budgetMs: 20_000 });
        if (report.skipped) return back({ error: `${def.name} needs a username and key first.` });
        const words = `Fetched ${report.fetched.toLocaleString('en-GB')}, ${report.added.toLocaleString('en-GB')} new plays of tracks in the library.`;
        return back({ ok: report.complete ? words : `${words} There’s more: press Sync again, or it carries on overnight.` });
      } catch (error) {
        return back({ error: error instanceof Error ? error.message : 'The sync failed.' });
      }
    }
    default:
      return new Response('Unknown intent', { status: 400 });
  }
};
