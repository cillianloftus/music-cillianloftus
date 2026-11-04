/**
 * Title normalisation for matching (ARCHITECTURE.md §5, Matching):
 * lowercased, accents and punctuation stripped, leading articles dropped,
 * and edition suffixes like "- Remastered 2011" or "(Deluxe)" removed.
 */

/**
 * Words that mark an edition of the same recording. "Live", "demo", "radio
 * edit" and "acoustic version" are deliberately absent: those are different
 * recordings, and stripping them would match a live take to the studio cut.
 */
const EDITION_WORDS = /\b(remaster(ed)?|deluxe|expanded|anniversary|edition|bonus track)\b/;

/** Drops "- Remastered 2011" and "(Deluxe Edition)" style suffixes. */
function stripEditionSuffixes(title: string): string {
  let result = title;
  // Trailing " - ..." segments that name an edition.
  result = result.replace(/\s+[-–—]\s+([^-–—]+)$/u, (match, tail: string) =>
    EDITION_WORDS.test(tail.toLowerCase()) ? '' : match,
  );
  // Bracketed segments that name an edition.
  result = result.replace(/\s*[([]([^)\]]+)[)\]]/gu, (match, inner: string) =>
    EDITION_WORDS.test(inner.toLowerCase()) ? '' : match,
  );
  return result;
}

export function normaliseTitle(title: string): string {
  return stripEditionSuffixes(title)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normaliseName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}
