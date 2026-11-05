import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { verifyAccessJwt, type AccessIdentity } from './lib/auth/access';
import { userForEmail } from './lib/auth/user';
import { currentStamp, forgetStamp, isCacheablePage, isKeepable, pageKey, PAGE_MAX_AGE } from './lib/page-cache';
import { THEME_COOKIE } from './lib/theme';

/** Paths behind the Access policy. Everything else is public. */
function isProtected(pathname: string): boolean {
  return (
    pathname === '/manage' ||
    pathname.startsWith('/manage/') ||
    pathname.startsWith('/edit/') ||
    pathname === '/queue' ||
    pathname.startsWith('/api/write/') ||
    pathname === '/api/query' ||
    pathname === '/query'
  );
}

async function identify(request: Request, cookie: string | undefined): Promise<AccessIdentity | null> {
  // Local development has no Access in front of it.
  if (import.meta.env.DEV) {
    return env.DEV_ACCESS_EMAIL ? { email: env.DEV_ACCESS_EMAIL } : null;
  }

  const teamDomain: string = env.ACCESS_TEAM_DOMAIN;
  const audience: string = env.ACCESS_AUD;
  if (!teamDomain || !audience) return null; // Fail closed when unconfigured.

  // Access injects the header on protected paths; the cookie lets public
  // pages recognise a signed-in visitor too.
  const token = request.headers.get('Cf-Access-Jwt-Assertion') ?? cookie;
  if (!token) return null;

  try {
    return await verifyAccessJwt(token, { teamDomain, audience });
  } catch (error) {
    console.error('Access verification failed', error);
    return null;
  }
}

/**
 * Where the management pages used to live (/edit, /edit/jobs…): moved to
 * /manage, the queue to /queue. Old addresses still arrive somewhere.
 * Editing one thing (/edit/album/…, /edit/rate/…) stays under /edit.
 */
const MOVED = /^\/edit(?:\/(backups|files|genres|history|import|jobs|refresh|review|roles|spotify|weights)(\/.*)?)?\/?$/;
function movedTo(pathname: string): string | null {
  if (pathname === '/edit/queue') return '/queue';
  const m = MOVED.exec(pathname);
  if (!m) return null;
  return m[1] ? `/manage/${m[1]}${m[2] ?? ''}` : '/manage';
}

export const onRequest = defineMiddleware(async (context, next) => {
  const moved = movedTo(context.url.pathname);
  if (moved) return context.redirect(`${moved}${context.url.search}`, 301);

  const identity = await identify(context.request, context.cookies.get('CF_Authorization')?.value);
  context.locals.user = identity ? await userForEmail(identity.email) : null;

  if (isProtected(context.url.pathname) && !context.locals.user) {
    return new Response('Sign-in required.', {
      status: 401,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // A write moves the site's state: forget the remembered stamp so this
  // isolate's next page is worked out afresh.
  if (context.request.method !== 'GET' && context.request.method !== 'HEAD') {
    const response = await next();
    forgetStamp();
    return response;
  }

  // Public pages come from the edge cache while the site is unchanged (see
  // src/lib/page-cache.ts). Not in development, where the code changes.
  if (import.meta.env.DEV || context.request.method !== 'GET' || !isCacheablePage(context.url.pathname)) return next();
  const cache = (caches as unknown as { default: Cache }).default;
  let key: Request;
  try {
    key = pageKey(context.url, await currentStamp(), context.locals.user?.id ?? null, context.cookies.get(THEME_COOKIE)?.value);
    const hit = await cache.match(key);
    if (hit) {
      // The edge keeps it; the browser asks again each time, so a new rating shows at once.
      const served = new Response(hit.body, hit);
      served.headers.set('Cache-Control', 'private, no-cache');
      return served;
    }
  } catch (error) {
    console.warn('Page cache unavailable', error);
    return next();
  }

  const response = await next();
  if (!isKeepable(response)) return response;
  const kept = new Response(response.body, response);
  kept.headers.set('Cache-Control', `public, max-age=${PAGE_MAX_AGE}`);
  const copy = kept.clone();
  // The visitor gets the page as it streams; the copy is stored once it has.
  const stored = cache.put(key, copy).catch((error) => console.warn('Page cache put failed', error));
  const ctx = (context.locals as { cfContext?: { waitUntil(p: Promise<unknown>): void } }).cfContext;
  if (ctx) ctx.waitUntil(stored);
  // Browsers revalidate: the next visit asks again and the edge answers.
  kept.headers.set('Cache-Control', 'private, no-cache');
  return kept;
});
