// The service worker that makes the site installable as an app (a WebAPK
// on Android: its own icon, no browser badge). It caches one offline page:
// every request goes to the network as usual, so nothing is ever stale, and
// a page that cannot be reached at all shows the offline page instead of
// the browser's. It also shows notifications (below).
//
// And your own music kept on this device (Keep on this device, /play):
// the audio (AUDIO_CACHE), served from here with or without a network,
// byte ranges and all, and the player pages that play it with what they
// load (PLAYER_CACHE), shown when the network is not there.

const CACHE = 'offline-v1';
const AUDIO_CACHE = 'audio-v1';
const PLAYER_CACHE = 'player-v1';
// Kept across updates of this worker: deleting them would lose your offline music.
const KEEP = [CACHE, AUDIO_CACHE, PLAYER_CACHE];
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
      for (const key of await caches.keys()) if (!KEEP.includes(key)) await caches.delete(key);
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

/** A kept audio file, whole or the range asked for (an audio element seeks by ranges). */
async function keptAudio(request) {
  const cache = await caches.open(AUDIO_CACHE);
  const kept = await cache.match(new URL(request.url).pathname);
  if (!kept) return null;
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
  if (!range || (!range[1] && !range[2])) return kept;
  const blob = await kept.blob();
  const size = blob.size;
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start >= size || end < start) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'content-type': kept.headers.get('content-type') || 'audio/mpeg',
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
    },
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Your audio: kept on this device first (no data used, works anywhere), else the network.
  if (url.pathname.startsWith('/audio/')) {
    event.respondWith((async () => (await keptAudio(request)) || fetch(request))());
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return (await event.preloadResponse) || (await fetch(request));
        } catch {
          // No network: a kept player page, else the offline page (which lists them).
          return (await (await caches.open(PLAYER_CACHE)).match(url.pathname + url.search)) || (await caches.match(OFFLINE)) || Response.error();
        }
      })(),
    );
    return;
  }

  // What a kept player page loads (scripts, styles, covers): the network, else the kept copy.
  if (url.pathname.startsWith('/_astro/') || url.pathname.startsWith('/art/') || /\.(?:woff2?|svg|png)$/.test(url.pathname)) {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          return (await (await caches.open(PLAYER_CACHE)).match(request)) || Response.error();
        }
      })(),
    );
  }
});
