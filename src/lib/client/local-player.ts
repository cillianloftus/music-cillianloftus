/**
 * Your own files, playing on while you move about the site, the way
 * Spotify's app does (17 Nov). Browser-only.
 *
 * A page that is left takes its audio with it, so the first Play turns the
 * page into a shell: the audio stays in it, and the site carries on in a
 * frame over the whole screen, each page loading there as it always has.
 * The shell keeps its address and title in step with the frame, so the
 * address bar, reloading and the back button behave as before (a reload
 * stops the music, as it would anywhere). Later Plays, from any page in the
 * frame, hand the shell a new queue.
 *
 * Everything else hears about it on a BroadcastChannel ('local-player'):
 * the mini player (NowBar), Now playing (rating and lyrics as it plays) and
 * /play, which can also host the player on its own (opened directly, or
 * kept on the device to play with no signal). They steer it with commands
 * on the same channel.
 */

export interface LocalTrack {
  fileId: string;
  recordingId: string;
  title: string;
  artist: string;
  album: string | null;
  albumId: string | null;
  artKey: string | null;
  lengthMs: number | null;
}

/** What the player says is on, every couple of seconds and at each change. */
export interface LocalState {
  recordingId: string;
  title: string;
  artist: string;
  album: string | null;
  albumId: string | null;
  artKey: string | null;
  /** A small cover, for the mini player. */
  art: string | null;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  index: number;
  queue: { recordingId: string; title: string }[];
  /** Something to tell the listener (a tap needed, a file that will not play). */
  problem: string | null;
}

export type LocalMessage =
  | { type: 'state'; state: LocalState }
  | { type: 'hello' }
  | { type: 'stopped' }
  | { type: 'command'; cmd: 'toggle' | 'play' | 'pause' | 'next' | 'previous' }
  | { type: 'command'; cmd: 'seek'; ms: number }
  | { type: 'command'; cmd: 'jump'; index: number };

export const CHANNEL = 'local-player';

declare global {
  interface Window {
    __localPlayer?: LocalPlayer;
  }
}

/** A moment of silence: played inside the tap, so the phone lets the real song start once its queue arrives. */
const SILENCE = 'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQIAAACAgA==';

const HELD = 'listens-waiting';

/**
 * What is on, kept in the tab (sessionStorage) so a reload carries on from
 * the same second (17 Nov: refreshing to see an edit stopped the music).
 */
const RESUME = 'local-player-resume';
/** A song left playing is picked up after a reload this soon; one left paused, for longer. */
const RESUME_PLAYING_MS = 10 * 60_000;
const RESUME_PAUSED_MS = 6 * 3_600_000;

interface Resume {
  queue: LocalTrack[];
  index: number;
  positionMs: number;
  playing: boolean;
  at: number;
}

export class LocalPlayer {
  queue: LocalTrack[] = [];
  index = 0;
  problem: string | null = null;
  private readonly channel = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL) : null;
  /** The song on now: when it began and how much was heard, seeks aside. */
  private listen: { recordingId: string; startedAt: string | null; heardMs: number; lastAt: number | null } | null = null;

  constructor(readonly audio: HTMLAudioElement) {
    const on = (type: string, handler: () => void) => audio.addEventListener(type, () => this.queue.length > 0 && handler());
    on('play', () => {
      this.problem = null;
      if (this.listen && !this.listen.startedAt) this.listen.startedAt = new Date().toISOString();
      if (this.listen) this.listen.lastAt = performance.now();
      this.broadcast();
    });
    on('pause', () => {
      this.hear();
      this.broadcast();
    });
    on('seeking', () => {
      // Listening resumes from the new place; the jump itself is not heard.
      this.hear();
      if (this.listen) this.listen.lastAt = audio.paused ? null : performance.now();
    });
    on('ended', () => {
      if (this.index < this.queue.length - 1) this.go(this.index + 1, true);
      else {
        // The last song: its listen now, nothing follows to send it.
        this.hear();
        this.report();
        this.broadcast();
      }
    });
    on('error', () => {
      this.problem = 'This file would not play here.';
      this.broadcast();
    });
    on('loadedmetadata', () => this.broadcast());
    on('timeupdate', () => {
      this.hear();
      if ('mediaSession' in navigator && audio.duration && 'setPositionState' in navigator.mediaSession) {
        try {
          navigator.mediaSession.setPositionState({ duration: audio.duration, position: audio.currentTime, playbackRate: audio.playbackRate });
        } catch {}
      }
    });

    // The phone's lock screen, headphones and car.
    if ('mediaSession' in navigator) {
      const actions: [MediaSessionAction, MediaSessionActionHandler][] = [
        ['play', () => void this.play()],
        ['pause', () => audio.pause()],
        ['previoustrack', () => this.previous()],
        ['nexttrack', () => this.next()],
        ['seekto', (d) => d.seekTime !== undefined && (audio.currentTime = d.seekTime)],
      ];
      for (const [action, handler] of actions) {
        try {
          navigator.mediaSession.setActionHandler(action, handler);
        } catch {}
      }
    }

    // Say what is on every couple of seconds (so a closed player is noticed),
    // answer a page that has just opened, and take its commands.
    this.channel?.addEventListener('message', (event) => this.command(event.data as LocalMessage));
    setInterval(() => this.queue.length > 0 && this.broadcast(), 2000);
    addEventListener('pagehide', () => {
      this.hear();
      this.report(true);
      this.keep();
      this.channel?.postMessage({ type: 'stopped' } satisfies LocalMessage);
    });
    void this.sendHeld();
    addEventListener('online', () => void this.sendHeld());
  }

  /** Inside the tap that started it: lets the phone play once the queue has arrived. */
  prime(): void {
    if (this.queue.length > 0 || this.audio.getAttribute('src')) return;
    this.audio.src = SILENCE;
    void this.audio.play().catch(() => {});
  }

  load(queue: LocalTrack[], start: number, play: boolean): void {
    this.hear();
    this.report();
    // Copied, so a queue made in a page that is then left is not held through it.
    this.queue = queue.map((t) => ({ ...t }));
    this.go(start, play);
  }

  /** Where a reload should carry on from (pagehide, and with each word on the channel). */
  keep(): void {
    if (this.queue.length === 0) return;
    // The whole queue played out: nothing to carry on with.
    if (this.audio.ended && this.index === this.queue.length - 1) {
      try {
        sessionStorage.removeItem(RESUME);
      } catch {}
      return;
    }
    const saved: Resume = {
      queue: this.queue,
      index: this.index,
      positionMs: Math.round(this.audio.currentTime * 1000),
      playing: !this.audio.paused,
      at: Date.now(),
    };
    try {
      sessionStorage.setItem(RESUME, JSON.stringify(saved));
    } catch {}
  }

  /** Back where a reload left it: the same song, the same second, playing if it was. */
  resume(saved: Resume): void {
    this.queue = saved.queue;
    this.go(saved.index, saved.playing, saved.positionMs);
    // A browser that will not start sound by itself after a reload starts it at the first
    // tap or key anywhere (the frame's pages pass theirs on: wirePlayLinks).
    if (saved.playing) this.waitingForTap = true;
  }

  /** A reload's song is to play on, and the browser wants a tap first. */
  waitingForTap = false;

  /** A tap or key anywhere: carry on, if a reload left the music waiting for one. */
  tapped(): void {
    if (!this.waitingForTap) return;
    this.waitingForTap = false;
    if (this.audio.paused) void this.play();
  }

  go(i: number, play: boolean, fromMs = 0): void {
    if (this.queue.length === 0) return;
    // The song leaving (ended or skipped): its listen, as far as it went.
    this.hear();
    this.report();
    this.index = (i + this.queue.length) % this.queue.length;
    const t = this.queue[this.index]!;
    this.audio.src = `/audio/${t.fileId}`;
    if (fromMs > 0) {
      const audio = this.audio;
      audio.addEventListener('loadedmetadata', () => (audio.currentTime = fromMs / 1000), { once: true });
    }
    this.listen ={ recordingId: t.recordingId, startedAt: null, heardMs: 0, lastAt: null };
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title,
        artist: t.artist,
        album: t.album ?? '',
        artwork: t.artKey ? [{ src: new URL(`/${t.artKey}/500.jpg`, location.href).href, sizes: '500x500', type: 'image/jpeg' }] : [],
      });
    }
    this.broadcast();
    if (play) void this.play();
  }

  async play(): Promise<void> {
    try {
      await this.audio.play();
      this.problem = null;
      this.waitingForTap = false;
    } catch {
      // A browser may want a tap first.
      this.problem = 'Tap play to start.';
    }
    this.broadcast();
  }

  next(): void {
    this.go(this.index + 1, true);
  }

  previous(): void {
    if (this.audio.currentTime > 3) this.audio.currentTime = 0;
    else this.go(this.index - 1, true);
  }

  command(m: LocalMessage): void {
    if (m.type === 'hello') return this.broadcast();
    if (m.type !== 'command' || this.queue.length === 0) return;
    if (m.cmd === 'toggle') this.audio.paused ? void this.play() : this.audio.pause();
    else if (m.cmd === 'play') void this.play();
    else if (m.cmd === 'pause') this.audio.pause();
    else if (m.cmd === 'next') this.next();
    else if (m.cmd === 'previous') this.previous();
    else if (m.cmd === 'seek') this.audio.currentTime = Math.max(0, m.ms / 1000);
    else if (m.cmd === 'jump') this.go(m.index, true);
  }

  state(): LocalState | null {
    const t = this.queue[this.index];
    if (!t) return null;
    const a = this.audio;
    return {
      recordingId: t.recordingId,
      title: t.title,
      artist: t.artist,
      album: t.album,
      albumId: t.albumId,
      artKey: t.artKey,
      art: t.artKey ? `/${t.artKey}/250.jpg` : null,
      playing: !a.paused,
      positionMs: Math.round(a.currentTime * 1000),
      durationMs: Number.isFinite(a.duration) && a.duration > 0 ? Math.round(a.duration * 1000) : (t.lengthMs ?? 0),
      index: this.index,
      queue: this.queue.map((q) => ({ recordingId: q.recordingId, title: q.title })),
      problem: this.problem,
    };
  }

  broadcast(): void {
    const state = this.state();
    if (!state) return;
    // Heard by every other channel of the name, this window's own pages included.
    this.channel?.postMessage({ type: 'state', state } satisfies LocalMessage);
    this.keep();
  }

  // Each listen logged like any other play (api/write/audio/played): sent when the song
  // ends or changes, or the shell is left. Heard offline, they wait on this device.

  private hear(): void {
    const l = this.listen;
    if (!l) return;
    const now = performance.now();
    // Time heard while playing, a second at most between updates (a seek is not listening).
    if (l.lastAt !== null && !this.audio.paused) l.heardMs += Math.min(1000, now - l.lastAt);
    l.lastAt = this.audio.paused ? null : now;
  }

  private report(beacon = false): void {
    const l = this.listen;
    if (!l?.startedAt || l.heardMs < 1000) return;
    const body = JSON.stringify({ recordingId: l.recordingId, playedAt: l.startedAt, msPlayed: Math.round(l.heardMs) });
    this.listen = null;
    if (!navigator.onLine) return hold(body);
    if (beacon && navigator.sendBeacon) navigator.sendBeacon('/api/write/audio/played', new Blob([body], { type: 'application/json' }));
    else
      void fetch('/api/write/audio/played', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true })
        .then((res) => !res.ok && res.status >= 500 && hold(body))
        .catch(() => hold(body));
  }

  private async sendHeld(): Promise<void> {
    const waiting = held();
    if (!waiting.length || !navigator.onLine) return;
    const left: string[] = [];
    for (const body of waiting) {
      const res = await fetch('/api/write/audio/played', { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => null);
      if (!res || res.status >= 500) left.push(body);
    }
    try {
      localStorage.setItem(HELD, JSON.stringify(left));
    } catch {}
  }
}

function held(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HELD) || '[]') as string[];
  } catch {
    return [];
  }
}

function hold(body: string): void {
  try {
    localStorage.setItem(HELD, JSON.stringify([...held(), body].slice(-500)));
  } catch {}
}

/** The player of the shell this page is framed in, if it is. */
export function framedHost(): LocalPlayer | null {
  try {
    return window.top && window.top !== window ? (window.top.__localPlayer ?? null) : null;
  } catch {
    return null;
  }
}

/** The player in this window, made if there is none yet. */
export function hostPlayer(): LocalPlayer {
  if (window.__localPlayer) return window.__localPlayer;
  const audio = document.createElement('audio');
  audio.preload = 'auto';
  audio.hidden = true;
  document.body.appendChild(audio);
  window.__localPlayer = new LocalPlayer(audio);
  return window.__localPlayer;
}

/**
 * This page becomes the shell: the site goes on in a frame over it, from
 * this same address, and this page's own content is hidden once the frame
 * has drawn (until then it stays, so nothing flashes).
 */
function becomeShell(): void {
  if (document.querySelector('iframe.site-frame')) return;
  const style = document.createElement('style');
  style.textContent = `
    :root[data-shell], :root[data-shell] body { overflow: hidden; height: 100%; }
    :root[data-shell] body > :not(.site-frame) { display: none !important; }
    .site-frame {
      position: fixed; z-index: 2147483000;
      top: env(safe-area-inset-top); right: env(safe-area-inset-right);
      bottom: env(safe-area-inset-bottom); left: env(safe-area-inset-left);
      width: calc(100% - env(safe-area-inset-left) - env(safe-area-inset-right));
      height: calc(100% - env(safe-area-inset-top) - env(safe-area-inset-bottom));
      border: 0; background: var(--bg, #000); visibility: hidden;
    }
    :root[data-shell] .site-frame { visibility: visible; }`;
  document.head.appendChild(style);
  const frame = document.createElement('iframe');
  frame.className = 'site-frame';
  frame.title = document.title;
  frame.src = location.href;
  // Reloading with the keys reloads the page in the frame; the music carries on.
  addEventListener('keydown', (event) => {
    if (!isReloadKey(event)) return;
    event.preventDefault();
    frame.contentWindow?.location.reload();
  });
  frame.addEventListener('load', () => {
    document.documentElement.setAttribute('data-shell', '');
    // The address and title follow the frame, so a reload or a shared link lands where you are.
    try {
      const w = frame.contentWindow!;
      history.replaceState(history.state, '', w.location.pathname + w.location.search + w.location.hash);
      document.title = w.document.title;
      frame.title = w.document.title;
    } catch {}
  });
  document.body.appendChild(frame);
}

/**
 * Play (?album, ?track or ?playlist) from your own files: in the shell this
 * page is framed in, or here, making this page the shell. Returns false
 * when there is nothing uploaded to play, so the caller can go to /play,
 * which says so.
 */
export async function startLocal(params: URLSearchParams): Promise<boolean> {
  const framed = framedHost();
  const player = framed ?? hostPlayer();
  player.prime();
  try {
    const res = await fetch(`/api/play-queue?${params}`, { headers: { accept: 'application/json' } });
    const data = (await res.json()) as { queue?: LocalTrack[]; start?: number };
    if (!res.ok || !data.queue?.length) return false;
    player.load(data.queue, data.start ?? 0, true);
  } catch {
    return false;
  }
  if (!framed && !location.pathname.startsWith('/play')) becomeShell();
  return true;
}

/**
 * Every Play link (to /play) starts the music here, rather than opening the
 * player page; and in the shell's frame, links to other sites open in a new
 * tab, as leaving the frame for them would stop the music. Once per page.
 */
export function wirePlayLinks(): void {
  // A reload left the music waiting for a tap (a browser that will not start it alone): this one.
  // A tap in the frame counts for the shell around it too.
  for (const type of ['pointerdown', 'keydown'] as const) {
    document.addEventListener(type, () => (framedHost() ?? window.__localPlayer)?.tapped(), { capture: true });
  }
  // In the shell's frame, F5 or Ctrl+R reloads this page only, and the music carries on.
  document.addEventListener('keydown', (event) => {
    if (!isReloadKey(event) || !framedHost()) return;
    event.preventDefault();
    location.reload();
  });
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!link) return;
    const url = new URL(link.href, location.href);
    if (url.origin === location.origin && url.pathname === '/play' && url.search) {
      event.preventDefault();
      void startLocal(url.searchParams).then((ok) => !ok && location.assign(url.href));
      return;
    }
    if (url.origin !== location.origin && framedHost() && (!link.target || link.target === '_self')) link.target = '_blank';
  });
}

function isReloadKey(event: KeyboardEvent): boolean {
  return event.key === 'F5' || ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'r');
}

/**
 * After a reload (or the shell left and come back to in this tab): the
 * shell again, carrying on from where the music was. A song left playing
 * plays on (a phone with the site installed as an app allows it; else the
 * mini player shows it paused, a tap away); one left paused waits paused.
 */
export function resumeAfterReload(): void {
  if (window.top !== window || window.__localPlayer || location.pathname.startsWith('/play')) return;
  let saved: Resume | null = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(RESUME) || 'null') as Resume | null;
  } catch {}
  if (!saved?.queue?.length) return;
  if (Date.now() - saved.at > (saved.playing ? RESUME_PLAYING_MS : RESUME_PAUSED_MS)) {
    try {
      sessionStorage.removeItem(RESUME);
    } catch {}
    return;
  }
  hostPlayer().resume(saved);
  becomeShell();
}
