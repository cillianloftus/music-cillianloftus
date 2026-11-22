import type { APIContext, MiddlewareNext } from 'astro';
import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { verifyAccessJwt, type AccessIdentity } from './lib/auth/access';
import { userForEmail } from './lib/auth/user';
import { devCold } from './lib/library-cache';
import { inRequest } from './lib/request-scope';
import { bumpWrites, currentStamps, forgetStamp, isCacheablePage, isKeepable, isStale, movesPages, pageKey, PAGE_MAX_AGE, RENDERED_HEADER, STAMP_HEADER, type Stamps } from './lib/page-cache';
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

// Each request in its own scope (src/lib/request-scope.ts); in development, metered.
export const onRequest = defineMiddleware((context, next) =>
  inRequest(() => (import.meta.env.DEV ? metered(context, next) : handle(context, next))),
);

/** Development: logs each page's D1 rows read (src/lib/dev/rows-meter.ts). */
async function metered(context: APIContext, next: MiddlewareNext): Promise<Response> {
  const meter = await import('./lib/dev/rows-meter');
  meter.meterRows(env.DB);
  return meter.counted(async (report) => {
    // ?__cold: as after a rating, with the library cache empty.
    const cold = context.url.searchParams.has('__cold');
    devCold.on = cold;
    const response = await handle(context, next);
    return meter.reportWhenDone(response, () => {
      devCold.on = false;
      report(`${context.request.method} ${context.url.pathname}${cold ? ' (cold)' : ''}`);
    });
  });
}

async function handle(context: APIContext, next: MiddlewareNext): Promise<Response> {
  // Pictures are public and the same for everyone: no sign-in check and no
  // database read before each one (a page can show eighty).
  if (context.url.pathname.startsWith('/art/')) return next();

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

  // A write moves the site's state: what people do moves every page's key
  // (bumpWrites, before answering, so their next page is fresh), and this
  // isolate forgets its remembered stamps.
  if (context.request.method !== 'GET' && context.request.method !== 'HEAD') {
    const response = await next();
    if (context.locals.user && movesPages(context.url.pathname)) await bumpWrites().catch((error) => console.warn('Writes stamp failed', error));
    forgetStamp();
    return response;
  }

  // Public pages come from the edge cache (see src/lib/page-cache.ts), and
  // one kept at an older state of the site is served while it is rendered
  // again behind it. Not in development, where the code changes.
  if (import.meta.env.DEV || context.request.method !== 'GET' || !isCacheablePage(context.url.pathname)) return next();
  const cache = (caches as unknown as { default: Cache }).default;
  const ctx = (context.locals as { cfContext?: { waitUntil(p: Promise<unknown>): void } }).cfContext;
  let key: Request;
  let stamps: Stamps;
  try {
    stamps = await currentStamps();
    key = pageKey(context.url, stamps.mine, context.locals.user?.id ?? null, context.cookies.get(THEME_COOKIE)?.value);
    const hit = await cache.match(key);
    if (hit) {
      if (ctx && isStale(hit, stamps.full) && !refreshing.has(key.url)) {
        refreshing.add(key.url);
        const again = key;
        ctx.waitUntil(
          next()
            .then((fresh) => (isKeepable(fresh) ? cache.put(again, toKeep(fresh, stamps.full)) : undefined))
            .catch((error) => console.warn('Page refresh failed', error))
            .finally(() => refreshing.delete(again.url)),
        );
      }
      // The edge keeps it; the browser asks again each time, so a new rating shows at once.
      return forVisitor(hit);
    }
  } catch (error) {
    console.warn('Page cache unavailable', error);
    return next();
  }

  const response = await next();
  if (!isKeepable(response)) return response;
  const kept = toKeep(response, stamps.full);
  const copy = kept.clone();
  // The visitor gets the page as it streams; the copy is stored once it has.
  const stored = cache.put(key, copy).catch((error) => console.warn('Page cache put failed', error));
  if (ctx) ctx.waitUntil(stored);
  return forVisitor(kept);
}

/** Pages being rendered again behind a visit, in this isolate: one at a time each. */
const refreshing = new Set<string>();

/** A rendered page as the edge keeps it: for a day, with the stamp and time it was rendered at. */
function toKeep(response: Response, full: string): Response {
  const kept = new Response(response.body, response);
  kept.headers.set('Cache-Control', `public, max-age=${PAGE_MAX_AGE}`);
  kept.headers.set(STAMP_HEADER, full);
  kept.headers.set(RENDERED_HEADER, String(Date.now()));
  return kept;
}

/** A kept page as sent: browsers revalidate, so the next visit asks again and the edge answers. */
function forVisitor(kept: Response): Response {
  const served = new Response(kept.body, kept);
  served.headers.set('Cache-Control', 'private, no-cache');
  // How old the page is, in seconds (HTTP's Age): 0 when rendered for this visit.
  const rendered = Number(kept.headers.get(RENDERED_HEADER) ?? 0);
  if (rendered) served.headers.set('Age', String(Math.max(0, Math.round((Date.now() - rendered) / 1000))));
  served.headers.delete(STAMP_HEADER);
  served.headers.delete(RENDERED_HEADER);
  return served;
}
