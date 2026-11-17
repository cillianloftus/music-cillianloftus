/**
 * Keep on this device: an album's or playlist's own files saved in this
 * browser, so they play with no signal (public/sw.js serves them). Saved:
 * each file's audio (the 'audio-v1' cache, whole), and the player page that
 * plays them (/play?album=…) with everything it loads ('player-v1'), so it
 * opens offline; listed for the offline page in localStorage
 * ('offline-kept'). Kept files are also played from here when online, so
 * they use no data. Per device and per browser; Spotify songs never are.
 * Browser-only (KeepButton.astro).
 */
import type { LocalTrack } from './local-player';

export interface KeptEntry {
  /** The player page that plays them. */
  url: string;
  title: string;
  count: number;
  /** The files kept, so a check needs no network. */
  files?: string[];
}

const KEPT = 'offline-kept';
const AUDIO = 'audio-v1';
const PAGES = 'player-v1';

/** Saving needs the cache and a service worker to serve from it (not in a private window, say). */
export function canKeep(): boolean {
  return 'caches' in window && Boolean(navigator.serviceWorker?.controller);
}

export function keptList(): KeptEntry[] {
  try {
    return JSON.parse(localStorage.getItem(KEPT) || '[]') as KeptEntry[];
  } catch {
    return [];
  }
}

function setKept(list: KeptEntry[]): void {
  try {
    localStorage.setItem(KEPT, JSON.stringify(list));
  } catch {}
}

/** The player page for a Play query ("album=…", "playlist=…", "track=…"). */
export const pageFor = (query: string) => `/play?${query}`;

/** Every file of the query kept here (and listed). */
export async function isKept(query: string): Promise<boolean> {
  const entry = keptList().find((k) => k.url === pageFor(query));
  if (!entry || !canKeep()) return false;
  const files = entry.files ?? [];
  if (files.length === 0) return false;
  const cache = await caches.open(AUDIO);
  for (const id of files) if (!(await cache.match(`/audio/${id}`))) return false;
  return true;
}

/** The query's own files (what plays with no network: never Spotify's). */
async function filesOf(query: string): Promise<LocalTrack[]> {
  const res = await fetch(`/api/play-queue?${query}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(String(res.status));
  const { queue } = (await res.json()) as { queue: LocalTrack[] };
  return queue.filter((t) => t.fileId);
}

/**
 * Saves the query's files and their player page. `progress` hears each file
 * as it is saved. Throws if saving stops (no space, the network went).
 */
export async function keep(query: string, fallbackTitle: string, progress: (done: number, total: number) => void): Promise<KeptEntry> {
  const files = await filesOf(query);
  const audio = await caches.open(AUDIO);
  for (const [i, t] of files.entries()) {
    progress(i, files.length);
    if (await audio.match(`/audio/${t.fileId}`)) continue;
    // The whole file (no range), kept as it came.
    const res = await fetch(`/audio/${t.fileId}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    await audio.put(`/audio/${t.fileId}`, res);
  }
  progress(files.length, files.length);
  await keepPage(pageFor(query));
  const album = query.startsWith('album=') || query.startsWith('track=') ? files[0]?.album : null;
  const entry: KeptEntry = { url: pageFor(query), title: album ?? fallbackTitle, count: files.length, files: files.map((t) => t.fileId!) };
  setKept([entry, ...keptList().filter((k) => k.url !== entry.url)]);
  return entry;
}

/** Takes the query's files off this device (those no other kept album or playlist still needs). */
export async function unkeep(query: string): Promise<void> {
  const url = pageFor(query);
  const entry = keptList().find((k) => k.url === url);
  const rest = keptList().filter((k) => k.url !== url);
  const stillNeeded = new Set(rest.flatMap((k) => k.files ?? []));
  const audio = await caches.open(AUDIO);
  for (const id of entry?.files ?? []) if (!stillNeeded.has(id)) await audio.delete(`/audio/${id}`);
  await (await caches.open(PAGES)).delete(url);
  setKept(rest);
}

/**
 * The player page and what it loads, so it opens with no network: its
 * scripts and styles (and the modules they import, found in their text),
 * covers and icons.
 */
async function keepPage(url: string): Promise<void> {
  const pages = await caches.open(PAGES);
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(String(res.status));
  const html = await res.clone().text();
  await pages.put(url, res);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const wanted = new Set<string>();
  const add = (raw: string | null) => {
    if (!raw) return;
    const u = new URL(raw, location.href);
    if (u.origin === location.origin && (u.pathname.startsWith('/_astro/') || u.pathname.startsWith('/art/') || /\.(?:woff2?|svg|png)$/.test(u.pathname))) {
      wanted.add(u.pathname);
    }
  };
  doc.querySelectorAll('script[src]').forEach((el) => add(el.getAttribute('src')));
  doc.querySelectorAll('link[href]').forEach((el) => add(el.getAttribute('href')));
  doc.querySelectorAll('img[src]').forEach((el) => add(el.getAttribute('src')));
  // Inline module scripts import their bundles: found in the page's text.
  for (const m of html.matchAll(/["'](\/_astro\/[^"']+\.(?:js|css))["']/g)) wanted.add(m[1]!);
  const done = new Set<string>();
  while (wanted.size > 0) {
    const path = wanted.values().next().value!;
    wanted.delete(path);
    if (done.has(path)) continue;
    done.add(path);
    const got = await fetch(path).catch(() => null);
    if (!got?.ok) continue;
    if (path.endsWith('.js')) {
      // Bundles import one another ("./chunk.js"): those too.
      const text = await got.clone().text();
      for (const m of text.matchAll(/["'](\.\/[^"']+\.js)["']/g)) wanted.add(new URL(m[1]!, location.origin + path).pathname);
    }
    await pages.put(path, got);
  }
}
