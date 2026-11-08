/**
 * Enhances AxisSlider rows: a large touch slider driving the hidden
 * number field that is submitted, a clear button, and "n/a". Safe to run
 * again over content swapped in later (Now playing changes track): a row
 * is enhanced once.
 */
import { scoreHue } from '../format';

const CLEAR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>';

export function enhanceAxes(root: Document | HTMLElement = document): void {
  for (const row of root.querySelectorAll<HTMLElement>('[data-axis]')) {
    if (row.dataset.ready) continue;
    row.dataset.ready = '1';
    const number = row.querySelector<HTMLInputElement>('.axis-number')!;
    const output = row.querySelector<HTMLOutputElement>('[data-value]')!;
    const head = row.querySelector('.axis-head')!;

    // The slider takes the label (by taking the id); the number field stays
    // in the form, hidden, as the value that is submitted.
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '10';
    range.step = '0.5';
    range.id = number.id;
    number.id = `${number.id}-typed`;
    const described = number.getAttribute('aria-describedby');
    if (described) range.setAttribute('aria-describedby', described);
    number.hidden = true;
    number.tabIndex = -1;

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'axis-clear';
    clear.innerHTML = CLEAR_ICON;
    clear.setAttribute('aria-label', `Clear ${row.querySelector('label')?.textContent ?? 'this axis'}`);

    const control = document.createElement('div');
    control.className = 'axis-control';
    control.appendChild(range);
    control.appendChild(clear);
    // "N/a" sits at the end of the slider's row, so each axis is two lines.
    const naLabel = row.querySelector('.axis-na');
    if (naLabel) control.appendChild(naLabel);
    head.parentNode!.insertBefore(control, head.nextSibling);

    const set = (value: number | null, announce = true) => {
      number.value = value === null ? '' : String(value);
      row.classList.toggle('is-unset', value === null);
      output.textContent = value === null ? '–' : String(value);
      range.setAttribute('aria-valuetext', value === null ? 'Not rated' : `${value} out of 10`);
      if (value === null) {
        range.value = '5';
        range.style.setProperty('--fill', '0%');
        output.style.color = '';
      } else {
        range.value = String(value);
        range.style.setProperty('--fill', `${value * 10}%`);
        if (row.dataset.tone === 'score') {
          const hue = scoreHue(value * 10);
          range.style.setProperty('--h', String(hue));
          output.style.color = `oklch(var(--score-l) var(--score-c) ${hue})`;
        } else {
          output.style.color = 'var(--accent)';
        }
      }
      // The live score preview listens on the form.
      if (announce) number.dispatchEvent(new Event('input', { bubbles: true }));
    };

    // "Doesn't apply": the slider stands down and the value reads n/a.
    const na = row.querySelector<HTMLInputElement>('[data-na]');
    const applyNa = () => {
      const off = Boolean(na?.checked);
      row.classList.toggle('is-na', off);
      range.disabled = off;
      if (off) {
        set(null);
        output.textContent = 'n/a';
      }
    };
    na?.addEventListener('change', applyNa);

    range.addEventListener('input', () => {
      if (na?.checked) {
        na.checked = false;
        applyNa();
      }
      set(Number(range.value));
    });
    // A tap exactly on the resting position changes nothing, so a click on
    // an unset slider sets it too.
    range.addEventListener('click', () => {
      if (row.classList.contains('is-unset')) set(Number(range.value));
    });
    clear.addEventListener('click', () => {
      set(null);
      range.focus();
    });

    set(number.value === '' ? null : Number(number.value), false);
    if (na?.checked) applyNa();
  }
}
