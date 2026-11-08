/**
 * Suggestions for every text box with a `list` (a <datalist> of artists,
 * genres): our own ARIA combobox in place of the browser's. Chrome on
 * Android draws a datalist as a see-through sheet over the page, unfiltered
 * when the list is long, so the browser's is never used.
 *
 * Without JavaScript the datalist still works as the browser draws it.
 *
 * The list floats on the page beside the box rather than in the form, so
 * the forms keep their layout; it opens above the box when the keyboard
 * leaves no room beneath.
 */

const MAX = 8;
let open: { input: HTMLInputElement; sheet: HTMLUListElement } | null = null;
let count = 0;

function place(input: HTMLInputElement, sheet: HTMLUListElement) {
  const box = input.getBoundingClientRect();
  const view = window.visualViewport;
  const bottom = view ? view.offsetTop + view.height : window.innerHeight;
  const below = bottom - box.bottom;
  const height = sheet.offsetHeight;
  const up = below < height + 8 && box.top > below;
  sheet.style.left = `${box.left + window.scrollX}px`;
  sheet.style.width = `${box.width}px`;
  sheet.style.top = up ? `${box.top + window.scrollY - height - 4}px` : `${box.bottom + window.scrollY + 4}px`;
}

function enhance(input: HTMLInputElement) {
  if (input.dataset.suggest || input.closest('chip-input')) return;
  const source = document.getElementById(input.getAttribute('list') ?? '');
  if (!(source instanceof HTMLDataListElement)) return;
  input.dataset.suggest = '1';
  input.removeAttribute('list');
  // Read when typed, not now: a datalist may be shared, or filled later.
  const options = () => [...source.options].map((o) => o.value);
  // A box marked data-many takes a comma-separated list: suggest for its last part.
  const many = input.hasAttribute('data-many');
  const parts = () => (many ? input.value.split(',') : [input.value]);

  const sheet = document.createElement('ul');
  sheet.id = `suggest-${++count}`;
  sheet.className = 'suggest-sheet';
  sheet.setAttribute('role', 'listbox');
  const label = input.labels?.[0]?.textContent?.trim() || input.placeholder || 'Suggestions';
  sheet.setAttribute('aria-label', `${label} suggestions`);
  sheet.hidden = true;
  document.body.appendChild(sheet);

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', sheet.id);

  let active = -1;
  const items = () => [...sheet.querySelectorAll<HTMLLIElement>('[role="option"]')];
  const close = () => {
    sheet.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
    if (open?.input === input) open = null;
  };
  const choose = (value: string) => {
    input.value = value;
    close();
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const highlight = (i: number) => {
    const all = items();
    active = all.length ? (i + all.length) % all.length : -1;
    all.forEach((li, j) => li.setAttribute('aria-selected', String(j === active)));
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', all[active]!.id);
      all[active]!.scrollIntoView({ block: 'nearest' });
    }
  };
  const refresh = () => {
    const q = parts().pop()!.trim().toLowerCase();
    if (!q) return close();
    const all = options();
    const starts = all.filter((o) => o.toLowerCase().startsWith(q));
    const rest = all.filter((o) => !o.toLowerCase().startsWith(q) && o.toLowerCase().includes(q));
    const matches = [...new Set([...starts, ...rest])].filter((m) => m.toLowerCase() !== q).slice(0, MAX);
    if (!matches.length) return close();
    sheet.replaceChildren(
      ...matches.map((m, i) => {
        const li = document.createElement('li');
        li.id = `${sheet.id}-${i}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        li.textContent = m;
        // Pointer down, not click: the box would lose focus first and close the list.
        li.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          const all = parts();
          all[all.length - 1] = (all.length > 1 ? ' ' : '') + m;
          choose(all.join(','));
        });
        return li;
      }),
    );
    if (open && open.input !== input) open.sheet.hidden = true;
    sheet.hidden = false;
    open = { input, sheet };
    input.setAttribute('aria-expanded', 'true');
    active = -1;
    place(input, sheet);
  };

  input.addEventListener('input', refresh);
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (event) => {
    if (sheet.hidden) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      highlight(active + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      items()[active]!.dispatchEvent(new PointerEvent('pointerdown', { cancelable: true }));
    }
  });
}

export function startSuggestions() {
  const all = (root: ParentNode) => root.querySelectorAll<HTMLInputElement>('input[list]').forEach(enhance);
  all(document);
  // Forms that save in place swap their markup: pick up new boxes as they arrive.
  document.addEventListener('focusin', (event) => {
    if (event.target instanceof HTMLInputElement && event.target.hasAttribute('list')) enhance(event.target);
  });
  new MutationObserver(() => all(document)).observe(document.body, { childList: true, subtree: true });
  const follow = () => open && place(open.input, open.sheet);
  window.addEventListener('resize', follow);
  window.visualViewport?.addEventListener('resize', follow);
  document.addEventListener('scroll', follow, { capture: true, passive: true });
}
