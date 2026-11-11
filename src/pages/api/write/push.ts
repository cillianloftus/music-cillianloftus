import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { NUDGE_TAG, pauseNudges, pushToUser, vapid } from '../../../lib/nudge';

/**
 * Notifications on this device (src/lib/nudge.ts): subscribe and
 * unsubscribe from Manage, a test message, and "Not today" from the
 * notification itself (sent by the service worker).
 */

const b64url = z.string().regex(/^[A-Za-z0-9_-]+$/).max(200);
const endpoint = z.url({ protocol: /^https$/ }).max(1000);
const body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('subscribe'), subscription: z.object({ endpoint, keys: z.object({ p256dh: b64url, auth: b64url }) }) }),
  z.object({ action: z.literal('unsubscribe'), endpoint }),
  z.object({ action: z.literal('test'), endpoint }),
  z.object({ action: z.literal('pause') }),
]);

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Not a request this knows.' }, { status: 400 });
  const input = parsed.data;

  switch (input.action) {
    case 'subscribe': {
      const { endpoint, keys } = input.subscription;
      await env.DB.prepare(
        `INSERT INTO push_subscription (endpoint, user_id, p256dh, auth) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      )
        .bind(endpoint, user.id, keys.p256dh, keys.auth)
        .run();
      return Response.json({ ok: true });
    }
    case 'unsubscribe':
      await env.DB.prepare('DELETE FROM push_subscription WHERE endpoint = ?1 AND user_id = ?2').bind(input.endpoint, user.id).run();
      return Response.json({ ok: true });
    case 'pause':
      await pauseNudges(user.id);
      return Response.json({ ok: true });
    case 'test': {
      const keys = vapid();
      if (!keys) return Response.json({ error: 'Notifications are not set up on the server.' }, { status: 503 });
      const sent = await pushToUser(
        user.id,
        { title: 'Notifications are on', body: 'Play something unrated on Spotify and it shows up here.', tag: NUDGE_TAG, url: '/manage' },
        keys,
        input.endpoint,
      );
      return sent ? Response.json({ ok: true }) : Response.json({ error: 'The push service did not take it. Turn notifications off and on again.' }, { status: 502 });
    }
  }
};
