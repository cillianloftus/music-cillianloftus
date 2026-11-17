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
  /** Your uploaded file, played here; or, with none, */
  fileId: string | null;
  /** the song on Spotify, which Spotify plays while this keeps time (a mixed queue). */
  spotifyId?: string | null;
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
  shuffle: boolean;
  repeat: Repeat;
  /** Where the song is playing from: your file here, or Spotify. */
  source: 'file' | 'spotify';
  /** Something to tell the listener (a tap needed, a file that will not play). */
  problem: string | null;
}

export type LocalMessage =
  | { type: 'state'; state: LocalState }
  | { type: 'hello' }
  | { type: 'stopped' }
  | { type: 'command'; cmd: 'toggle' | 'play' | 'pause' | 'next' | 'previous' }
  | { type: 'command'; cmd: 'seek'; ms: number }
  | { type: 'command'; cmd: 'jump'; index: number }
  | { type: 'command'; cmd: 'shuffle'; on: boolean }
  | { type: 'command'; cmd: 'repeat'; mode: Repeat };

/** Off, the whole queue again, or this song again. */
export type Repeat = 'off' | 'all' | 'one';

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
  shuffle?: boolean;
  repeat?: Repeat;
  order?: number[];
}

export class LocalPlayer {
  queue: LocalTrack[] = [];
  index = 0;
  problem: string | null = null;
  shuffle = false;
  repeat: Repeat = 'off';
  /** The queue's songs (their places in it) in the order they play: as listed, or shuffled. */
  order: number[] = [];
  private readonly channel = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL) : null;
  /**
   * A Spotify song of the queue: Spotify plays it, and this keeps its time
   * (from where it was last known, counting on while playing) to start what
   * follows when it ends. Meanwhile silence plays here, so a phone keeps the
   * page awake with its screen off and the lock screen shows this song.
   */
  private remote: { id: string; offsetMs: number; at: number; playing: boolean; durationMs: number; startedAt: number } | null = null;
  private remoteFailures = 0;
  private lastPoll = 0;
  /** The song on now: when it began and how much was heard, seeks aside. */
  private listen: { recordingId: string; startedAt: string | null; heardMs: number; lastAt: number | null } | null = null;

  constructor(readonly audio: HTMLAudioElement) {
    const on = (type: string, handler: () => void) => audio.addEventListener(type, () => this.queue.length > 0 && handler());
    on('play', () => {
      this.problem = null;
      const remote = this.remote;
      if (remote && !remote.playing) {
        remote.playing = true;
        remote.at = Date.now();
        void this.sendSpotify({ action: 'play' });
      }
      if (this.listen && !this.listen.startedAt) this.listen.startedAt = new Date().toISOString();
      if (this.listen) this.listen.lastAt = performance.now();
      this.broadcast();
    });
    on('pause', () => {
      const remote = this.remote;
      if (remote?.playing) {
        remote.offsetMs = this.remotePosition();
        remote.at = Date.now();
        remote.playing = false;
        void this.sendSpotify({ action: 'pause' });
      }
      this.hear();
      this.broadcast();
    });
    on('seeking', () => {
      // Listening resumes from the new place; the jump itself is not heard.
      this.hear();
      if (this.listen) this.listen.lastAt = audio.paused ? null : performance.now();
    });
    on('ended', () => this.finished());
    on('error', () => {
      if (this.remote) return;
      this.problem = 'This file would not play here.';
      this.broadcast();
    });
    on('loadedmetadata', () => this.broadcast());
    on('timeupdate', () => {
      this.hear();
      if (!this.remote && 'mediaSession' in navigator && audio.duration && 'setPositionState' in navigator.mediaSession) {
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
        ['seekto', (d) => d.seekTime !== undefined && this.seekTo(d.seekTime * 1000)],
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
    // A Spotify song's clock: its end starts what follows; Spotify is asked now and then.
    setInterval(() => this.tickRemote(), 1000);
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
    this.order = this.shuffle ? shuffled(this.queue.length, start) : this.queue.map((_, i) => i);
    this.go(start, play);
  }

  /** Where a reload should carry on from (pagehide, and with each word on the channel). */
  keep(): void {
    if (this.queue.length === 0) return;
    // The whole queue played out: nothing to carry on with.
    if (!this.remote && this.audio.ended && this.repeat === 'off' && this.order.indexOf(this.index) === this.order.length - 1) {
      try {
        sessionStorage.removeItem(RESUME);
      } catch {}
      return;
    }
    const saved: Resume = {
      queue: this.queue,
      index: this.index,
      positionMs: this.remote ? this.remotePosition() : Math.round(this.audio.currentTime * 1000),
      playing: this.remote ? this.remote.playing : !this.audio.paused,
      at: Date.now(),
      shuffle: this.shuffle,
      repeat: this.repeat,
      order: this.order,
    };
    try {
      sessionStorage.setItem(RESUME, JSON.stringify(saved));
    } catch {}
  }

  /** Back where a reload left it: the same song, the same second, playing if it was. */
  resume(saved: Resume): void {
    this.queue = saved.queue;
    this.shuffle = saved.shuffle ?? false;
    this.repeat = saved.repeat ?? 'off';
    this.order = saved.order?.length === saved.queue.length ? saved.order : saved.queue.map((_, i) => i);
    this.go(saved.index, saved.playing, saved.positionMs, true);
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

  go(i: number, play: boolean, fromMs = 0, resuming = false): void {
    if (this.queue.length === 0) return;
    // The song leaving (ended or skipped): its listen, as far as it went.
    this.hear();
    this.report();
    this.index = (i + this.queue.length) % this.queue.length;
    const t = this.queue[this.index]!;
    // Leaving a Spotify song for one of your files: Spotify stops (a Spotify song next replaces it anyway).
    const leaving = this.remote;
    this.remote = null;
    if (leaving?.playing && t.fileId) void this.sendSpotify({ action: 'pause' });
    if (t.fileId) {
      this.audio.loop = false;
      this.audio.src = `/audio/${t.fileId}`;
      if (fromMs > 0) {
        const audio = this.audio;
        audio.addEventListener('loadedmetadata', () => (audio.currentTime = fromMs / 1000), { once: true });
      }
      this.listen = { recordingId: t.recordingId, startedAt: null, heardMs: 0, lastAt: null };
    } else {
      // Spotify plays it (and counts the listen, as with any Spotify play); silence here.
      this.listen = null;
      this.remote = { id: t.spotifyId ?? '', offsetMs: fromMs, at: Date.now(), playing: play, durationMs: t.lengthMs ?? 0, startedAt: Date.now() };
      this.audio.loop = true;
      this.audio.src = silence();
      if (resuming) {
        // After a reload Spotify is still playing it: only catch up with where it is.
        this.lastPoll = 0;
      } else if (play) {
        const id = this.remote.id;
        void this.sendSpotify({ action: 'start', track: id, alone: true }).then((ok) => {
          if (this.remote?.id !== id) return;
          if (!ok) return this.remoteFailed(t.title);
          this.remoteFailures = 0;
          if (fromMs > 1000) void this.sendSpotify({ action: 'seek', positionMs: Math.round(fromMs) });
        });
      }
    }
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

  /** The next in play order (round to the first after the last). */
  next(): void {
    const at = this.order.indexOf(this.index);
    this.go(this.order[(at + 1) % this.order.length] ?? 0, true);
  }

  previous(): void {
    if ((this.remote ? this.remotePosition() / 1000 : this.audio.currentTime) > 3) this.seekTo(0);
    else {
      const at = this.order.indexOf(this.index);
      this.go(this.order[(at - 1 + this.order.length) % this.order.length] ?? 0, true);
    }
  }

  /** Shuffled from this song on (it stays playing, the rest in a new order), or back to the listed order. */
  setShuffle(on: boolean): void {
    this.shuffle = on;
    this.order = on ? shuffled(this.queue.length, this.index) : this.queue.map((_, i) => i);
    this.broadcast();
  }

  setRepeat(mode: Repeat): void {
    this.repeat = mode;
    this.broadcast();
  }

  command(m: LocalMessage): void {
    if (m.type === 'hello') return this.broadcast();
    if (m.type !== 'command' || this.queue.length === 0) return;
    if (m.cmd === 'toggle') this.audio.paused ? void this.play() : this.audio.pause();
    else if (m.cmd === 'play') void this.play();
    else if (m.cmd === 'pause') this.audio.pause();
    else if (m.cmd === 'next') this.next();
    else if (m.cmd === 'previous') this.previous();
    else if (m.cmd === 'seek') this.seekTo(m.ms);
    else if (m.cmd === 'jump') this.go(m.index, true);
    else if (m.cmd === 'shuffle') this.setShuffle(m.on);
    else if (m.cmd === 'repeat') this.setRepeat(m.mode);
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
      playing: this.remote ? this.remote.playing : !a.paused,
      positionMs: this.remote ? this.remotePosition() : Math.round(a.currentTime * 1000),
      durationMs: this.remote
        ? this.remote.durationMs || (t.lengthMs ?? 0)
        : Number.isFinite(a.duration) && a.duration > 0
          ? Math.round(a.duration * 1000)
          : (t.lengthMs ?? 0),
      source: this.remote ? 'spotify' : 'file',
      index: this.index,
      queue: this.queue.map((q) => ({ recordingId: q.recordingId, title: q.title })),
      shuffle: this.shuffle,
      repeat: this.repeat,
      problem: this.problem,
    };
  }

  /** The end of a song (your file's, or by the clock a Spotify song's): what follows, by order and repeat. */
  finished(): void {
    const at = this.order.indexOf(this.index);
    if (this.repeat === 'one') {
      if (this.remote) return this.go(this.index, true);
      // Heard through: a listen of its own, then from the top.
      this.hear();
      this.report();
      this.listen = { recordingId: this.queue[this.index]!.recordingId, startedAt: null, heardMs: 0, lastAt: null };
      this.audio.currentTime = 0;
      void this.play();
    } else if (at < this.order.length - 1) this.go(this.order[at + 1]!, true);
    else if (this.repeat === 'all') {
      if (this.shuffle) this.order = shuffled(this.queue.length, null);
      this.go(this.order[0]!, true);
    } else {
      // The last song: its listen now, nothing follows to send it.
      if (this.remote) {
        this.remote.offsetMs = this.remote.durationMs;
        this.remote.playing = false;
        this.audio.pause();
      }
      this.hear();
      this.report();
      this.broadcast();
    }
  }

  seekTo(ms: number): void {
    const to = Math.max(0, Math.round(ms));
    if (this.remote) {
      this.remote.offsetMs = to;
      this.remote.at = Date.now();
      void this.sendSpotify({ action: 'seek', positionMs: to });
      this.broadcast();
    } else this.audio.currentTime = to / 1000;
  }

  /** Where the Spotify song is by this clock. */
  private remotePosition(now = Date.now()): number {
    const r = this.remote;
    if (!r) return 0;
    const ms = r.offsetMs + (r.playing ? now - r.at : 0);
    return Math.max(0, r.durationMs ? Math.min(ms, r.durationMs) : ms);
  }

  private tickRemote(): void {
    const r = this.remote;
    if (!r) return;
    const now = Date.now();
    if (r.playing && r.durationMs && r.offsetMs + (now - r.at) >= r.durationMs - 250) return this.finished();
    if ('mediaSession' in navigator && r.durationMs && 'setPositionState' in navigator.mediaSession) {
      try {
        navigator.mediaSession.setPositionState({ duration: r.durationMs / 1000, position: this.remotePosition(now) / 1000, playbackRate: 1 });
      } catch {}
    }
    // Spotify asked every ten seconds: the song's true length and place, and whether it was
    // paused or skipped on Spotify itself.
    if (now - this.lastPoll > 10_000) {
      this.lastPoll = now;
      void this.pollSpotify(r);
    }
  }

  private async pollSpotify(r: NonNullable<LocalPlayer['remote']>): Promise<void> {
    const sent = performance.now();
    const res = await fetch('/api/write/player', { headers: { accept: 'application/json' } }).catch(() => null);
    if (!res?.ok || this.remote !== r) return;
    const state = (await res.json().catch(() => null)) as {
      playing: boolean;
      progressMs: number;
      track: { spotifyId: string; durationMs: number } | null;
    } | null;
    if (this.remote !== r) return;
    const at = Date.now() - (performance.now() - sent) / 2;
    if (state?.track?.spotifyId === r.id) {
      r.durationMs = state.track.durationMs || r.durationMs;
      r.offsetMs = state.progressMs;
      r.at = at;
      // Paused on Spotify itself (its app, a speaker): paused here too.
      if (r.playing && !state.playing && state.progressMs < r.durationMs - 1500) {
        r.playing = false;
        this.audio.pause();
      } else if (!r.playing && state.playing) {
        r.playing = true;
        void this.audio.play().catch(() => {});
      }
      this.broadcast();
    } else if (r.playing && Date.now() - r.startedAt > 8000) {
      // Spotify has moved on from it (skipped on Spotify, or its own autoplay after it ended): on with the queue.
      this.finished();
    }
  }

  private remoteFailed(title: string): void {
    this.remoteFailures++;
    this.problem = `Spotify would not play “${title}”.`;
    this.broadcast();
    // Past a few in a row Spotify is not reachable (not connected, no device awake): stop.
    if (this.remoteFailures < 3) setTimeout(() => this.next(), 1500);
    else if (this.remote) {
      this.remote.playing = false;
      this.audio.pause();
    }
  }

  /** A command to Spotify (api/write/player): true when it took it. */
  private async sendSpotify(body: Record<string, unknown>): Promise<boolean> {
    const res = await fetch('/api/write/player', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null);
    return Boolean(res?.ok);
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

let silenceUrl: string | null = null;

/**
 * Ten seconds of silence, looped while Spotify plays a song of the queue.
 * Long enough that a phone gives it a media notification (one under five
 * seconds gets none), which is what keeps the page running with the screen off.
 */
function silence(): string {
  if (silenceUrl) return silenceUrl;
  const rate = 8000;
  const samples = rate * 10;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, 'data');
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  silenceUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  return silenceUrl;
}

/** The places 0..n-1 in a random order, `first` (the song on now) leading when given. */
export function shuffled(n: number, first: number | null): number[] {
  const rest = Array.from({ length: n }, (_, i) => i).filter((i) => i !== first);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j]!, rest[i]!];
  }
  return first === null ? rest : [first, ...rest];
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
