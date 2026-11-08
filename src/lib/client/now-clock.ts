/**
 * The song's clock in the browser, for Now playing and the mini player.
 *
 * Spotify is only asked every few seconds, so between answers the position
 * is counted on here. To feel like Spotify's own player:
 *
 *  - Each answer is timed by this device's clock when it arrives (less half
 *    the round trip), never the server's, so a skewed clock can't drift it.
 *  - An answer that agrees with the local count to within a little is not
 *    snapped to, so the bar never twitches back and forth.
 *  - Play, pause and seek show at once; answers for a moment afterwards that
 *    still say otherwise are Spotify catching up, and are not shown.
 *  - When a song runs out, the next one in Spotify's queue is shown at once,
 *    and answers still naming the old song are ignored until Spotify agrees.
 *
 * The last state is kept in sessionStorage so the mini player can be drawn
 * before the page first paints, rather than popping in after a request.
 */
import type { NowState } from '../spotify/now-state';

export type Track = NonNullable<NowState['track']>;

export const STORE_KEY = 'now-state';
/** Agreement close enough not to snap to. */
const SNAP_MS = 700;
/** How long Spotify is given to catch up with a command. */
const HOLD_MS = 2500;
/** Ask for the queue this close to the end of a song. */
export const NEXT_WINDOW_MS = 30_000;

export class NowClock {
  state: NowState | null;
  /** Until then, answers about the same song keep the local play state and position. */
  private holdUntil = 0;
  /** A song moved on from ahead of Spotify, and until when to disbelieve answers naming it. */
  private leaving: { id: string; until: number } | null = null;

  constructor(state: NowState | null) {
    this.state = state;
  }

  position(now = Date.now()): number {
    const s = this.state;
    if (!s?.track) return 0;
    const ms = s.progressMs + (s.playing ? now - s.at : 0);
    return Math.max(0, Math.min(ms, s.track.durationMs));
  }

  /** Past the end of the song by the local count. */
  ended(now = Date.now()): boolean {
    const s = this.state;
    return Boolean(s?.track && s.playing && s.progressMs + (now - s.at) >= s.track.durationMs);
  }

  wantsNext(now = Date.now()): boolean {
    const s = this.state;
    return Boolean(s?.track && s.track.durationMs - this.position(now) < NEXT_WINDOW_MS);
  }

  /** Take an answer from Spotify, stamped on arrival. Returns true when the song changed. */
  accept(fresh: NowState | null, now = Date.now()): boolean {
    const prev = this.state;
    const prevId = prev?.track?.spotifyId ?? '';
    if (fresh && this.leaving && now < this.leaving.until && fresh.track?.spotifyId === this.leaving.id) {
      return false; // Still the song moved on from: Spotify hasn't caught up.
    }
    if (this.leaving && (now >= this.leaving.until || fresh?.track?.spotifyId !== this.leaving.id)) this.leaving = null;

    if (fresh && prev?.track && fresh.track?.spotifyId === prevId) {
      if (now < this.holdUntil) {
        fresh.playing = prev.playing;
        fresh.shuffle = prev.shuffle;
        fresh.repeat = prev.repeat;
        fresh.progressMs = this.position(now);
        fresh.at = now;
      } else if (fresh.playing === prev.playing) {
        const theirs = fresh.progressMs + (fresh.playing ? now - fresh.at : 0);
        if (Math.abs(theirs - this.position(now)) < SNAP_MS) {
          fresh.progressMs = prev.progressMs;
          fresh.at = prev.at;
        }
      }
      // An answer without the queue keeps the one already known.
      if (fresh.next === undefined) fresh.next = prev.next;
    }
    this.state = fresh;
    this.save();
    return (fresh?.track?.spotifyId ?? '') !== prevId;
  }

  /** Play, pause, seek, shuffle or repeat, shown before Spotify confirms. */
  set(patch: Partial<Pick<NowState, 'playing' | 'progressMs' | 'shuffle' | 'repeat'>>, now = Date.now()) {
    if (!this.state) return;
    this.state = { ...this.state, progressMs: this.position(now), ...patch, at: now };
    this.holdUntil = now + HOLD_MS;
    this.save();
  }

  /**
   * Move on to the next song ahead of Spotify: at the end of a song, or on
   * Next. Repeat-one starts the same song again. Returns true when the song
   * changed; false when there is nothing known to move to.
   */
  advance(now = Date.now()): boolean {
    const s = this.state;
    if (!s?.track) return false;
    if (s.repeat === 'track' && this.ended(now)) {
      this.state = { ...s, progressMs: 0, at: now };
      return false;
    }
    if (!s.next) return false;
    // Whatever ran past the end of the last song counts towards this one.
    const over = this.ended(now) ? Math.max(0, s.progressMs + (now - s.at) - s.track.durationMs) : 0;
    this.leaving = { id: s.track.spotifyId, until: now + 6000 };
    this.state = { ...s, track: s.next, next: undefined, playing: true, progressMs: over, at: now };
    this.save();
    return true;
  }

  save() {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(this.state));
    } catch {
      /* Private mode: the bar just draws a moment later. */
    }
  }
}

/** Ask the site what Spotify is playing, timed by this device's clock. */
export async function fetchNow(
  withNext: boolean,
): Promise<{ ok: true; state: NowState | null } | { ok: false; error: string | null; reason: string | null }> {
  const sent = performance.now();
  const res = await fetch(`/api/write/player${withNext ? '?next=1' : ''}`, { headers: { accept: 'application/json' } });
  const data = (await res.json().catch(() => null)) as (NowState & { error?: string; reason?: string }) | null;
  // reason 'scope': not connected, or connected without the player's permissions.
  if (!res.ok) return { ok: false, error: data?.error ?? null, reason: data?.reason ?? null };
  // Spotify measured the position somewhere in the middle of the round trip.
  if (data) data.at = Date.now() - (performance.now() - sent) / 2;
  return { ok: true, state: data };
}
