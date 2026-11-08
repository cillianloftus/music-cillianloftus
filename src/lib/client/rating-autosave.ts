/**
 * Rating forms save themselves: a few seconds after the last change, and at
 * once when the page is left or hidden (or, on Now playing, when the song
 * moves on). Ratings are append-only, so the wait matters: one row per
 * pause in the rating, not one per nudge of a slider. Nothing is sent when
 * the form is back to what was last saved, or holds no score at all.
 *
 * Without JavaScript the form keeps its Save button and posts as before.
 */

const WAIT_MS = 3000;

interface Saver {
  flush: (leaving?: boolean) => void;
}

const savers = new WeakMap<HTMLFormElement, Saver>();

/** The form as it would be sent, for telling whether anything changed. */
const snapshot = (form: HTMLFormElement) => new URLSearchParams(new FormData(form) as unknown as Record<string, string>).toString();

/** True when at least one score (or a not-applicable mark) is set. */
function hasScore(form: HTMLFormElement): boolean {
  for (const [name, value] of new FormData(form)) {
    if (name.startsWith('na_')) return true;
    if (['entity_type', 'entity_id', 'return_to', 'impact_note'].includes(name)) continue;
    if (String(value).trim() !== '') return true;
  }
  return false;
}

export function enhanceAutosave(root: Document | HTMLElement = document): void {
  for (const form of root.querySelectorAll<HTMLFormElement>('form[data-rating-sheet]')) {
    if (savers.has(form)) continue;
    const status = form.querySelector<HTMLElement>('[data-save-status]');
    let saved = snapshot(form);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let everSaved = false;
    form.dataset.autosave = '';

    const say = (text: string, tone: '' | 'error' = '') => {
      if (!status) return;
      status.textContent = text;
      status.dataset.tone = tone;
    };

    const save = async (leaving = false) => {
      clearTimeout(timer);
      timer = undefined;
      const now = snapshot(form);
      if (now === saved || !hasScore(form)) {
        say(now === saved && everSaved ? 'Saved' : '');
        return;
      }
      if (inFlight && !leaving) {
        // One save at a time; this change goes once the last one lands.
        timer = setTimeout(() => void save(), 500);
        return;
      }
      inFlight = true;
      say('Saving…');
      try {
        const res = await fetch(form.action, {
          method: 'POST',
          body: new FormData(form),
          headers: { accept: 'application/json' },
          // Still delivered when the page is going away.
          keepalive: leaving,
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string; quality?: number | null; personal?: number | null };
        if (res.ok) {
          saved = now;
          everSaved = true;
          // For a page showing the score: what this rating makes it now.
          form.dispatchEvent(new CustomEvent('rating:saved', { bubbles: true, detail: { quality: data.quality ?? null, personal: data.personal ?? null } }));
          say(snapshot(form) === saved ? 'Saved' : 'Unsaved changes');
          // Pages showing scores are out of date now.
          try {
            sessionStorage.setItem('soft-stale', document.referrer ? new URL(document.referrer).pathname : '/');
          } catch {}
        } else {
          say(data.error ?? 'Not saved. It tries again on the next change.', 'error');
        }
      } catch {
        say('Not saved: offline? It tries again on the next change.', 'error');
      } finally {
        inFlight = false;
      }
    };

    const changed = () => {
      clearTimeout(timer);
      const same = snapshot(form) === saved;
      say(same ? (everSaved ? 'Saved' : '') : 'Unsaved changes');
      timer = setTimeout(() => void save(), WAIT_MS);
    };
    form.addEventListener('input', changed);
    form.addEventListener('change', changed);
    // A submit (Enter in the note, or no-JS habits) saves now, in place.
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      void save();
    });

    savers.set(form, { flush: (leaving) => void save(leaving) });
  }
}

/** Save at once anything waiting in the forms under root (before they are replaced). */
export function flushAutosave(root: Document | HTMLElement = document, leaving = false): void {
  for (const form of root.querySelectorAll<HTMLFormElement>('form[data-rating-sheet]')) savers.get(form)?.flush(leaving);
}

// Leaving or hiding the page (switching app, locking the phone) saves too.
addEventListener('pagehide', () => flushAutosave(document, true));
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushAutosave(document, true));
