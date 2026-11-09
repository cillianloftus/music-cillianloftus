/**
 * Every artist name, for the boxes that suggest them (a credit's Who, an
 * album's artist), fetched the first time such a box is focused and put in
 * each `datalist[data-artist-names]`. Thousands of names: written into the
 * page they made every edit page heavy and cost a full read of artists each
 * load. Mark the box itself with data-artist-names (the suggestion list,
 * suggest.ts, takes its list attribute away).
 *
 * Importing this module installs it; imported twice, it still runs once.
 */

let names: Promise<void> | null = null;

function fill(): Promise<void> {
  return (names ??= fetch('/api/write/artist-names')
    .then((r) => (r.ok ? (r.json() as Promise<string[]>) : []))
    .then((list) => {
      for (const datalist of document.querySelectorAll('datalist[data-artist-names]')) {
        const fragment = document.createDocumentFragment();
        for (const name of list) {
          const option = document.createElement('option');
          option.value = name;
          fragment.appendChild(option);
        }
        datalist.replaceChildren(fragment);
      }
    })
    .catch(() => {
      names = null; // try again on the next focus
    }));
}

document.addEventListener('focusin', (event) => {
  const input = event.target;
  if (input instanceof HTMLInputElement && input.hasAttribute('data-artist-names')) void fill();
});
