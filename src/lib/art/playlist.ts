/**
 * Generated playlist art (ARCHITECTURE.md §3, "Playlist art"): composed
 * from the playlist's own data, never a model's guess at a mood. Same
 * inputs, same image, so every playlist belongs to one visual family and
 * the picture actually says something about what is in it:
 *
 *   - a barcode, one line per track: across by release year on a fixed
 *     timeline (so an 80s playlist sits left of a 2020s one), height by
 *     score, colour by genre family
 *   - a sun: its size is the mean score, its position the median year
 *   - the sky: the two biggest genre families
 *   - a strip along the top: the share of each genre family
 *
 * Colour comes from a hash of the root genre's name, so "bedroom pop" and
 * "indie pop" share pop's hue and differ only in lightness.
 */

export interface ArtItem {
  score: number | null;
  year: number | null;
  genre: string | null;
  /** The genre's top-level ancestor, which sets the hue. */
  root: string | null;
}

export const ART_SIZE = 640;
export const TIMELINE_START = 1950;

const PAD = 40;
const BASELINE = 600;
const HORIZON = 440;
const FALLBACK_HUE = 35; // the site's amber

/** FNV-1a: a stable small hash, so a name always maps to the same colour. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const hueOf = (root: string | null) => (root ? hash(root.toLowerCase()) % 360 : FALLBACK_HUE);
/** Subgenres vary lightness within their family's hue. */
const lightnessOf = (genre: string | null) => (genre ? 52 + (hash(genre.toLowerCase()) % 17) : 60);

const f = (n: number) => (Math.round(n * 10) / 10).toString();

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Genre families by number of tracks, largest first; ties by name. */
export function familyShares(items: ArtItem[]): { root: string | null; count: number }[] {
  const counts = new Map<string | null, number>();
  for (const item of items) counts.set(item.root, (counts.get(item.root) ?? 0) + 1);
  return [...counts]
    .map(([root, count]) => ({ root, count }))
    // Untagged last; then by name, so equal counts never swap places.
    .sort((a, b) => b.count - a.count || Number(a.root === null) - Number(b.root === null) || (a.root ?? '').localeCompare(b.root ?? ''));
}

export function playlistArtSvg(items: ArtItem[], options: { thisYear?: number } = {}): string {
  const W = ART_SIZE;
  const thisYear = options.thisYear ?? new Date().getUTCFullYear();
  const span = Math.max(1, thisYear + 1 - TIMELINE_START);
  const xOfYear = (year: number) => PAD + ((Math.min(Math.max(year, TIMELINE_START), thisYear) - TIMELINE_START) / span) * (W - 2 * PAD);
  const yearWidth = (W - 2 * PAD) / span;

  const families = familyShares(items).filter((s) => s.root !== null);
  const skyHue = hueOf(families[0]?.root ?? null);
  const groundHue = hueOf(families[1]?.root ?? families[0]?.root ?? null);

  const scores = items.map((i) => i.score).filter((s): s is number => s !== null);
  const years = items.map((i) => i.year).filter((y): y is number => y !== null);
  const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 50;

  // Ids unique to the content, so several of these inlined in one page never share gradients.
  const id = hash(JSON.stringify(items.map((i) => [i.score, i.year, i.genre, i.root]).sort())).toString(36);
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}" width="${W}" height="${W}">`,
    `<defs>`,
    `<linearGradient id="sky-${id}" x1="0" y1="0" x2="0.4" y2="1">`,
    `<stop offset="0" stop-color="hsl(${skyHue} 38% 20%)"/>`,
    `<stop offset="1" stop-color="hsl(${groundHue} 30% 8%)"/>`,
    `</linearGradient>`,
    `<radialGradient id="sun-${id}"><stop offset="0" stop-color="hsl(${skyHue} 75% 68%)"/><stop offset="1" stop-color="hsl(${skyHue} 70% 56%)"/></radialGradient>`,
    `</defs>`,
    `<rect width="${W}" height="${W}" fill="url(#sky-${id})"/>`,
  );

  if (items.length > 0) {
    // The sun: mean score sets the size, median year the place.
    const r = 50 + mean * 1.5;
    // Kept inside the frame: a playlist of this year's music would otherwise set at the edge.
    const cx = Math.min(Math.max(years.length ? xOfYear(median(years)) : W / 2, r + 16), W - r - 16);
    parts.push(`<circle cx="${f(cx)}" cy="${f(HORIZON - r * 0.35)}" r="${f(r)}" fill="url(#sun-${id})" opacity="0.9"/>`);
    parts.push(`<rect y="${HORIZON}" width="${W}" height="${W - HORIZON}" fill="hsl(${groundHue} 30% 7%)" opacity="0.85"/>`);

    // The barcode. Tracks of one year share that year's slot, side by side.
    const dated = items
      .filter((i): i is ArtItem & { year: number } => i.year !== null)
      .sort((a, b) => a.year - b.year || (b.score ?? -1) - (a.score ?? -1) || String(a.genre).localeCompare(String(b.genre)));
    const perYear = new Map<number, number>();
    for (const item of dated) perYear.set(item.year, (perYear.get(item.year) ?? 0) + 1);
    const seen = new Map<number, number>();
    const stroke = Math.max(1, Math.min(4, yearWidth * 0.6));
    for (const item of dated) {
      const index = seen.get(item.year) ?? 0;
      seen.set(item.year, index + 1);
      const count = perYear.get(item.year)!;
      // Spread a crowded year a little beyond its own slot rather than stacking.
      const spread = Math.min(yearWidth * Math.max(1, count / 3), 60);
      const x = xOfYear(item.year) + (count > 1 ? (index / (count - 1) - 0.5) * spread : 0);
      const height = item.score === null ? 14 : 18 + item.score * 1.3;
      const opacity = item.score === null ? 0.4 : 0.9;
      parts.push(
        `<line x1="${f(x)}" y1="${BASELINE}" x2="${f(x)}" y2="${f(BASELINE - height)}" stroke="hsl(${hueOf(item.root)} 65% ${lightnessOf(item.genre)}%)" stroke-width="${f(stroke)}" stroke-linecap="round" opacity="${opacity}"/>`,
      );
    }

    // The family strip, across the top.
    let x = PAD;
    const total = items.length;
    for (const { root, count } of familyShares(items)) {
      const width = ((W - 2 * PAD) * count) / total;
      parts.push(`<rect x="${f(x)}" y="${PAD}" width="${f(Math.max(1, width - 2))}" height="6" rx="3" fill="hsl(${hueOf(root)} 60% ${root ? 60 : 35}%)"/>`);
      x += width;
    }
  }

  parts.push(`</svg>`);
  return parts.join('');
}
