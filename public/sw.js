// The service worker that makes the site installable as an app (a WebAPK
// on Android: its own icon, no browser badge). It caches nothing but one
// offline page: every request goes to the network as usual, so nothing is
// ever stale, and a page that cannot be reached at all shows the offline
// page instead of the browser's. It also shows notifications (below).

const CACHE = 'offline-v1';
const OFFLINE = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE, { cache: 'reload' })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      // Lets page loads start while the worker wakes, so it costs no time.
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
      await self.clients.claim();
    })(),
  );
});

// Notifications (src/lib/nudge.ts): a song playing on Spotify that is in
// the library and not yet rated. One tag, so each new song replaces the
// last; renotify off, so a replacement updates the shade without buzzing.
self.addEventListener('push', (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {}
  const { title = 'Music', body = '', icon, tag = 'rate-now', url = '/' } = message;
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: icon || '/icon-192.png',
      tag,
      data: { url },
      actions: tag === 'rate-now' && url.startsWith('/edit/rate/') ? [{ action: 'pause', title: 'Not today' }] : [],
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'pause') {
    event.waitUntil(
      fetch('/api/write/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'pause' }),
        credentials: 'same-origin',
      }).catch(() => {}),
    );
    return;
  }
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      // An open window of the app goes to the page; otherwise a new one opens.
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        return open.navigate(url).catch(() => self.clients.openWindow(url));
      }
      return self.clients.openWindow(url);
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    (async () => {
      try {
        return (await event.preloadResponse) || (await fetch(event.request));
      } catch {
        return (await caches.match(OFFLINE)) || Response.error();
      }
    })(),
  );
});
