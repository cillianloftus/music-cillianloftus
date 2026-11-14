/**
 * The live score under a rating form: what this rating makes the track or
 * album, as it is moved, by the views' own rules (src/lib/scoring.ts; the
 * page's numbers from src/lib/score-preview.ts). A track by gut alone uses
 * its own conversion (the gut level, its artist, its genres); an album
 * blends the rating with what its tracks give. Runs over any
 * form[data-rating-sheet] not yet set up, so Now playing can swap a new
 * track's form in and call it again.
 */
import { ALBUM_KEYS, CRAFT_KEYS, albumComposite, craftComposite } from '../scoring';
import { scoreTone, scoreWord } from '../format';
import type { ScorePreview } from '../score-preview';

/** The gap at a gut score, half steps between their neighbours (scoring.ts, levelGap). */
function levelGap(levels: number[], gut: number): number {
  const g = Math.max(0, Math.min(10, gut));
  const lo = Math.floor(g);
  const hi = Math.ceil(g);
  return lo === hi ? levels[lo]! : levels[lo]! + (levels[hi]! - levels[lo]!) * (g - lo);
}

const signed = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}`;

export function enhancePreviews(root: Document | HTMLElement = document): void {
  for (const form of root.querySelectorAll<HTMLFormElement>('form[data-rating-sheet]')) {
    if (form.dataset.ready) continue;
    form.dataset.ready = '1';
    const out = form.querySelector<HTMLElement>('[data-preview]');
    if (!out || !form.dataset.preview) continue;
    const config = JSON.parse(form.dataset.preview) as ScorePreview;
    const { entityType, weights, offset } = config;
    const value = (name: string) => {
      const field = form.elements.namedItem(name) as HTMLInputElement | null;
      if (!field || field.value.trim() === '') return null;
      const n = Number(field.value);
      return Number.isFinite(n) && n >= 0 && n <= 10 ? n : null;
    };
    // The impact note only once there is an impact (one already written stays in view).
    const note = form.querySelector<HTMLElement>('[data-impact-note]');
    const noteText = note?.querySelector('textarea');
    const showNote = () => {
      if (note) note.hidden = !(value('impact') ?? 0) && !noteText?.value.trim();
    };
    form.addEventListener('input', showNote);
    showNote();

    const number = out.querySelector<HTMLElement>('[data-preview-score]')!;
    const word = out.querySelector<HTMLElement>('[data-preview-word]')!;
    const how = out.querySelector<HTMLElement>('[data-preview-how]')!;

    const update = () => {
      const axes = Object.fromEntries([...CRAFT_KEYS, ...ALBUM_KEYS].map((k) => [k, value(k)]));
      const composite = entityType === 'recording' ? craftComposite(axes, weights) : albumComposite(axes, weights);
      const gut = value('gut_score');
      const conversion = config.conversion;
      const gap = gut === null ? 0 : conversion ? levelGap(conversion.levels, gut) + conversion.extra : offset;
      const own = composite ?? (gut === null ? null : gut + gap);

      let score: number | null = null;
      let explain = '';
      if (entityType === 'recording') {
        if (own !== null) {
          score = Math.max(0, Math.min(100, own * 10));
          if (composite !== null) explain = 'From the parts.';
          else if (conversion) {
            const parts = [conversion.artist && `artist ${signed(conversion.artist * 10)}`, conversion.genre && `genres ${signed(conversion.genre * 10)}`].filter(Boolean);
            explain = `From your gut${parts.length ? `: ${parts.join(', ')}` : ''}.`;
          } else explain = 'From your gut.';
        }
      } else {
        const tracks = config.tracks ?? null;
        const mine = own === null ? null : Math.max(0, Math.min(100, own * 10));
        const { tracks: wt, album_axes: wa } = weights.release;
        score = tracks === null ? mine : mine === null ? tracks : (wt * tracks + wa * mine) / (wt + wa);
        explain =
          tracks !== null && mine !== null
            ? `Tracks ${Math.round(tracks)}, this rating ${Math.round(mine)}.`
            : tracks !== null
              ? `From the tracks rated; rate the album to add to it.`
              : 'From this rating alone: no tracks rated yet.';
      }

      out.hidden = score === null;
      if (score === null) return;
      const rounded = Math.round(score);
      const impact = value('impact') ?? 0;
      const tone = scoreTone(rounded);
      number.className = `score-number tabular ${tone.className}`;
      number.setAttribute('style', tone.style);
      number.textContent = String(rounded);
      word.textContent = scoreWord(rounded) + (impact ? ` · impact ${impact}` : '');
      how.textContent = explain;
    };
    form.addEventListener('input', update);
    update();
  }
}
