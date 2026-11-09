/**
 * Things remembered for one request only. A page's sections run at once
 * and often want the same value (the library stamp, a user's album
 * scores); this lets them share one promise. Shared between requests, a
 * promise still pending is unsafe on Workers (if the request that started
 * it is cancelled, the others can wait forever), so across requests only
 * settled values are shared, and pending ones never leave their request.
 *
 * The middleware runs each request inside `inRequest`. Outside one (the
 * cron, tests) nothing is remembered and every call does its own work.
 * Needs the nodejs_als compatibility flag (wrangler.jsonc).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

export function inRequest<T>(fn: () => T): T {
  return storage.run(new Map(), fn);
}

/** The promise for key in this request, started by make the first time it is asked for. */
export function perRequest<T>(key: string, make: () => Promise<T>): Promise<T> {
  const store = storage.getStore();
  if (!store) return make();
  const known = store.get(key);
  if (known) return known as Promise<T>;
  const made = make();
  store.set(key, made);
  // A failure is not remembered: the next ask tries again.
  made.catch(() => store.get(key) === made && store.delete(key));
  return made;
}
