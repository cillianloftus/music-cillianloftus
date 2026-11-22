/**
 * Generated playlist art (ARCHITECTURE.md §3, "Playlist art"): composed
 * from the playlist's own data, never a model's guess at a mood. Same
 * inputs, same image, so every playlist belongs to one visual family and
 * the picture actually says something about what is in it:
 *
 *   - a barcode across the whole width, one bar per track in order of
 *     release, over the playlist's own years: height by score among the
 *     playlist's own (a best-of's scores all sit in the 90s, and on a
 *     0-100 scale every bar stood the same), colour by genre family (a fixed 1950-to-now timeline crushed a playlist of the
 *     last fifteen years into a sliver at one edge)
 *   - a glow behind it: its size is the mean score, its place the median year
 *   - the sky: the biggest genre family, the ground the next
 *   - its name, large, and a line of what it holds (songs, years, average),
 *     so the covers tell apart in Spotify's grid (22 Nov)
 *
 * Genre families take colours from one set, picked so any two sit well
 * together; the family's name decides which, so it is the same on every cover.
 */

export interface ArtItem {
  score: number | null;
  year: number | null;
  genre: string | null;
  /** The genre's top-level ancestor, which sets the colour. */
  root: string | null;
}

export const ART_SIZE = 640;

const PAD = 44;
const BASELINE = 388;
const BAR_MAX = 210;
const BAR_MIN = 46;
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

/** A hue for a name (artist initials, the genre map): any of 360. */
export const hueOf = (root: string | null) => (root ? hash(root.toLowerCase()) % 360 : FALLBACK_HUE);

/**
 * The covers' colours: twelve hues a step apart, each at a saturation and
 * lightness that reads on the dark sky, so no family lands on a garish one.
 */
const PALETTE: { h: number; s: number; l: number }[] = [
  { h: 8, s: 70, l: 64 }, // coral
  { h: 32, s: 82, l: 62 }, // amber
  { h: 48, s: 80, l: 62 }, // gold
  { h: 88, s: 45, l: 58 }, // olive
  { h: 145, s: 42, l: 56 }, // sage
  { h: 172, s: 48, l: 52 }, // teal
  { h: 196, s: 62, l: 60 }, // sky
  { h: 222, s: 58, l: 68 }, // cornflower
  { h: 256, s: 48, l: 70 }, // lavender
  { h: 286, s: 42, l: 66 }, // orchid
  { h: 326, s: 58, l: 68 }, // rose
  { h: 350, s: 62, l: 62 }, // raspberry
];
const NO_FAMILY = { h: 40, s: 10, l: 55 };

export const familyColour = (root: string | null) => (root ? PALETTE[hash(root.toLowerCase()) % PALETTE.length]! : NO_FAMILY);
const hsl = (c: { h: number; s: number; l: number }, dl = 0, a = 1) =>
  `hsl(${c.h} ${c.s}% ${Math.max(0, Math.min(100, c.l + dl))}%${a < 1 ? ` / ${a}` : ''})`;
/** Subgenres vary lightness a little within their family's colour. */
const shadeOf = (genre: string | null) => (genre ? (hash(genre.toLowerCase()) % 13) - 6 : 0);

const f = (n: number) => (Math.round(n * 10) / 10).toString();
const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

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

/**
 * The name in at most two lines, as large as fits, one line first while it
 * stays 48 or more: about 0.56 of the size per character for a bold system
 * sans, so long names step down rather than run off.
 */
export function titleLines(title: string, width = ART_SIZE - 2 * PAD): { lines: string[]; size: number } {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const widthAt = (text: string, size: number) => text.length * size * 0.56;
  // One line while it can stay large; two only when one would be small.
  for (const size of [64, 56, 48]) {
    if (widthAt(words.join(' '), size) <= width) return { lines: [words.join(' ')], size };
  }
  for (const size of [64, 56, 48, 42, 36, 32]) {
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (widthAt(next, size) <= width || !line) line = next;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    if (lines.length <= 2 && lines.every((l) => widthAt(l, size) <= width)) return { lines, size };
  }
  // Too long for two lines even small: two lines, the second cut short.
  const size = 32;
  const max = Math.floor(width / (size * 0.56));
  const first = title.slice(0, max).replace(/\s+\S*$/, '');
  const rest = title.slice(first.length).trim();
  return { lines: [first, rest.length > max ? `${rest.slice(0, max - 1).trimEnd()}…` : rest].filter(Boolean), size };
}

export interface ArtOptions {
  /** The playlist's name, drawn large; none draws the picture alone. */
  title?: string;
}

export function playlistArtSvg(items: ArtItem[], options: ArtOptions = {}): string {
  const W = ART_SIZE;
  const families = familyShares(items).filter((s) => s.root !== null);
  const sky = familyColour(families[0]?.root ?? null);
  const ground = familyColour(families[1]?.root ?? families[0]?.root ?? null);

  const scores = items.map((i) => i.score).filter((s): s is number => s !== null);
  const years = items.map((i) => i.year).filter((y): y is number => y !== null);
  const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const first = years.length ? Math.min(...years) : null;
  const last = years.length ? Math.max(...years) : null;

  // Ids unique to the content, so several of these inlined in one page never share gradients.
  const id = hash(JSON.stringify([options.title ?? '', items.map((i) => [i.score, i.year, i.genre, i.root]).sort()])).toString(36);
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}" width="${W}" height="${W}">`,
    `<defs>`,
    `<linearGradient id="sky-${id}" x1="0" y1="0" x2="0.35" y2="1">`,
    `<stop offset="0" stop-color="hsl(${sky.h} ${Math.round(sky.s * 0.45)}% 19%)"/>`,
    `<stop offset="0.62" stop-color="hsl(${ground.h} ${Math.round(ground.s * 0.35)}% 10%)"/>`,
    `<stop offset="1" stop-color="hsl(${ground.h} ${Math.round(ground.s * 0.3)}% 6%)"/>`,
    `</linearGradient>`,
    `<radialGradient id="glow-${id}">`,
    `<stop offset="0" stop-color="${hsl(sky, 8, 0.75)}"/>`,
    `<stop offset="0.55" stop-color="${hsl(sky, 0, 0.28)}"/>`,
    `<stop offset="1" stop-color="${hsl(sky, 0, 0)}"/>`,
    `</radialGradient>`,
    `<linearGradient id="fade-${id}" x1="0" y1="0" x2="0" y2="1">`,
    `<stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="0.55"/>`,
    `</linearGradient>`,
    `<mask id="bars-${id}"><rect width="${W}" height="${W}" fill="url(#fade-${id})"/></mask>`,
    `</defs>`,
    `<rect width="${W}" height="${W}" fill="url(#sky-${id})"/>`,
  );

  if (items.length > 0) {
    // The barcode: every track, oldest first, across the whole width.
    const dated = [...items].sort(
      (a, b) =>
        (a.year ?? 9999) - (b.year ?? 9999) ||
        (b.score ?? -1) - (a.score ?? -1) ||
        String(a.root).localeCompare(String(b.root)) ||
        String(a.genre).localeCompare(String(b.genre)),
    );
    const span = W - 2 * PAD;
    const slot = span / dated.length;
    const bar = slot > 3 ? Math.min(slot * 0.72, 22) : slot;
    const lo = scores.length ? Math.min(...scores) : 0;
    const hi = scores.length ? Math.max(...scores) : 100;
    const heightOf = (score: number) => (hi - lo < 1 ? (BAR_MIN + BAR_MAX) / 2 + 30 : BAR_MIN + ((score - lo) / (hi - lo)) * (BAR_MAX - BAR_MIN));

    // The glow: the mean score sets its size, the median year its place along the bars.
    if (mean !== null) {
      const r = 70 + (Math.max(0, mean - 40) / 60) * 120;
      const medianYear = years.length ? median(years) : null;
      const at = medianYear === null ? 0.5 : (dated.findIndex((i) => (i.year ?? 9999) >= medianYear) + 0.5) / dated.length;
      const cx = Math.min(Math.max(PAD + at * span, r * 0.6), W - r * 0.6);
      parts.push(`<circle cx="${f(cx)}" cy="${f(BASELINE - 120)}" r="${f(r * 1.6)}" fill="url(#glow-${id})"/>`);
    }

    parts.push(`<g mask="url(#bars-${id})">`);
    dated.forEach((item, i) => {
      const x = PAD + i * slot + (slot - bar) / 2;
      const height = item.score === null ? 18 : heightOf(item.score);
      const colour = familyColour(item.root);
      const fill = item.score === null ? hsl(colour, -18, 0.55) : hsl(colour, shadeOf(item.genre));
      parts.push(`<rect x="${f(x)}" y="${f(BASELINE - height)}" width="${f(Math.max(1, bar))}" height="${f(height)}" rx="${f(Math.min(bar / 2, 3))}" fill="${fill}"/>`);
    });
    parts.push(`</g>`);
    // The ground line the bars stand on.
    parts.push(`<rect x="${PAD}" y="${BASELINE + 6}" width="${span}" height="2" rx="1" fill="${hsl(ground, 0, 0.35)}"/>`);
  }

  // The name and what it holds.
  const facts = [
    items.length ? `${items.length} ${items.length === 1 ? 'song' : 'songs'}` : 'Empty',
    first !== null && last !== null ? (first === last ? `${first}` : `${first}–${last}`) : null,
    mean !== null ? `averages ${Math.round(mean)}` : null,
  ].filter(Boolean);
  const font = `font-family="system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"`;
  if (options.title) {
    const { lines, size } = titleLines(options.title);
    const lineHeight = size * 1.05;
    const top = 520 - (lines.length - 1) * lineHeight;
    lines.forEach((line, i) => {
      parts.push(
        `<text x="${PAD}" y="${f(top + i * lineHeight)}" ${font} font-size="${size}" font-weight="800" letter-spacing="${f(-size * 0.02)}" fill="#fbf7ef">${escapeXml(line)}</text>`,
      );
    });
  }
  parts.push(`<text x="${PAD}" y="${W - PAD + 4}" ${font} font-size="20" font-weight="600" fill="${hsl(sky, 18, 0.9)}">${escapeXml(facts.join('  ·  '))}</text>`);

  parts.push(`</svg>`);
  return parts.join('');
}
