/**
 * The live "Gives 87" line under a rating form, by the views' own formula
 * (src/lib/scoring.ts). Runs over any form[data-rating-sheet] not yet set
 * up, so Now playing can swap a new track's form in and call it again.
 */
import { ALBUM_KEYS, CRAFT_KEYS, albumComposite, craftComposite, type Weights } from '../scoring';

interface Config {
  entityType: string;
  weights: Weights;
  offset: number;
}

export function enhancePreviews(root: Document | HTMLElement = document): void {
  for (const form of root.querySelectorAll<HTMLFormElement>('form[data-rating-sheet]')) {
    if (form.dataset.ready) continue;
    form.dataset.ready = '1';
    const out = form.querySelector<HTMLElement>('[data-preview]');
    if (!out || !form.dataset.preview) continue;
    const { entityType, weights, offset } = JSON.parse(form.dataset.preview) as Config;
    const value = (name: string) => {
      const field = form.elements.namedItem(name) as HTMLInputElement | null;
      if (!field || field.value.trim() === '') return null;
      const n = Number(field.value);
      return Number.isFinite(n) && n >= 0 && n <= 10 ? n : null;
    };
    const update = () => {
      const axes = Object.fromEntries([...CRAFT_KEYS, ...ALBUM_KEYS].map((k) => [k, value(k)]));
      const composite = entityType === 'recording' ? craftComposite(axes, weights) : albumComposite(axes, weights);
      const gut = value('gut_score');
      const base = composite ?? (gut === null ? null : gut + offset);
      if (base === null) {
        out.textContent = '';
        return;
      }
      const quality = Math.round(Math.max(0, Math.min(100, base * 10)));
      const impact = value('impact') ?? 0;
      const how = composite !== null ? 'from the parts' : 'from your gut, calibrated';
      const mark = impact ? `, impact ${impact}` : '';
      out.textContent =
        entityType === 'recording' ? `Gives ${quality}${mark}, ${how}.` : `Album axes give ${quality}${mark}; the tracks make up the rest.`;
    };
    form.addEventListener('input', update);
    update();
  }
}
