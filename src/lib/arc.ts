/**
 * An artist's career arc: each scored release placed by when it came out
 * and how it scores. The geometry lives here, apart from the SVG, so the
 * scales and the choice of what to label can be tested.
 */

export interface ArcRelease {
  id: string;
  title: string;
  type: string;
  /** YYYY, YYYY-MM or YYYY-MM-DD. */
  date: string;
  score: number;
}

export interface ArcPoint extends ArcRelease {
  x: number;
  y: number;
  /** Albums and mixtapes: the records an arc is drawn through. */
  major: boolean;
  /** Direct label beside the dot, for the best and worst records only. */
  label: 'best' | 'worst' | null;
  /** Where that label goes: the text's anchor point and which way it reads. */
  labelAt: { x: number; y: number; anchor: 'start' | 'end'; text: string } | null;
}

export interface Arc {
  width: number;
  height: number;
  plot: { left: number; right: number; top: number; bottom: number };
  points: ArcPoint[];
  /** The line through the major releases, in date order. */
  path: string;
  yTicks: { value: number; y: number }[];
  xTicks: { year: number; x: number }[];
  /** Both kinds present, so the dot sizes need a key. */
  mixed: boolean;
}

const MAJOR = new Set(['album', 'mixtape']);

/** When a release came out as a fractional year: 2016-07 is 2016.5. */
export function when(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number?, number?];
  return y + ((m ?? 7) - 1) / 12 + ((d ?? 15) - 1) / 365;
}

/** Enough to be an arc: three scored releases across at least two years. */
export function hasArc(releases: ArcRelease[]): boolean {
  return releases.length >= 3 && new Set(releases.map((r) => r.date.slice(0, 4))).size >= 2;
}

/** Tidy year steps: every year, then 2, 5, 10 as the span grows. */
function yearStep(span: number): number {
  return [1, 2, 5, 10, 20].find((s) => span / s <= 8) ?? 25;
}

export function arcOf(releases: ArcRelease[], width = 420, height = 220): Arc {
  const plot = { left: 30, right: width - 16, top: 12, bottom: height - 24 };
  const times = releases.map((r) => when(r.date));
  const first = Math.floor(Math.min(...times));
  const last = Math.ceil(Math.max(...times));
  const x = (t: number) => plot.left + ((t - first) / Math.max(1, last - first)) * (plot.right - plot.left);

  // From a tick below the lowest score to 100 (or above, for scores past it).
  const lowest = Math.min(...releases.map((r) => r.score));
  const highest = Math.max(...releases.map((r) => r.score));
  const ceiling = Math.max(100, Math.ceil(highest / 10) * 10);
  // Ticks every 10, or 20 over a wide range; the floor sits on a tick so they meet the top.
  const yStep = ceiling - Math.min(lowest - 5, 80) > 40 ? 20 : 10;
  const floor = Math.max(0, Math.min(Math.floor((lowest - 5) / yStep) * yStep, 80));
  const y = (s: number) => plot.bottom - ((s - floor) / (ceiling - floor)) * (plot.bottom - plot.top);

  const major = releases.filter((r) => MAJOR.has(r.type));
  // Label the extremes among the records; among everything if there are no records.
  const pool = major.length >= 2 ? major : releases;
  const best = pool.reduce((a, b) => (b.score > a.score ? b : a));
  const worst = pool.reduce((a, b) => (b.score < a.score ? b : a));

  const points: ArcPoint[] = releases
    .map((r) => ({
      ...r,
      x: x(when(r.date)),
      y: y(r.score),
      major: MAJOR.has(r.type),
      label: r.id === best.id ? ('best' as const) : r.id === worst.id && worst.score < best.score ? ('worst' as const) : null,
      labelAt: null,
    }))
    .sort((a, b) => a.x - b.x);

  for (const p of points) if (p.label) p.labelAt = placeLabel(p, points, plot);

  const line = points.filter((p) => p.major);
  const path = line.length >= 2 ? line.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') : '';

  const yTicks = [];
  for (let v = floor; v <= ceiling; v += yStep) yTicks.push({ value: v, y: y(v) });

  const step = yearStep(last - first);
  const xTicks = [];
  for (let year = Math.ceil(first / step) * step; year <= last; year += step) xTicks.push({ year, x: x(year) });

  return { width, height, plot, points, path, yTicks, xTicks, mixed: line.length > 0 && line.length < points.length };
}

/** Roughly how wide a label is at the chart's 11.5px text: enough to keep it off other dots. */
const CHAR = 6.3;
const LABEL_MAX = 26;

/**
 * A label's spot beside its dot: below or above, reading right or left,
 * whichever covers the fewest other dots and stays inside the plot, below
 * and rightwards when it is a tie.
 */
export function placeLabel(p: ArcPoint, points: ArcPoint[], plot: Arc['plot']): NonNullable<ArcPoint['labelAt']> {
  const text = p.title.length > LABEL_MAX ? `${p.title.slice(0, LABEL_MAX - 1)}…` : p.title;
  const w = text.length * CHAR;
  const candidates = [
    { dy: 17, anchor: 'start' as const },
    { dy: 17, anchor: 'end' as const },
    { dy: -10, anchor: 'start' as const },
    { dy: -10, anchor: 'end' as const },
  ].map(({ dy, anchor }) => {
    const x = p.x + (anchor === 'start' ? 4 : -4);
    const left = anchor === 'start' ? x : x - w;
    const box = { left, right: left + w, top: p.y + dy - 11, bottom: p.y + dy + 3 };
    const covered = points.filter((o) => o !== p && o.x + 6 > box.left && o.x - 6 < box.right && o.y + 6 > box.top && o.y - 6 < box.bottom).length;
    const outside = box.left < plot.left - 2 || box.right > plot.right + 2 || box.top < 0 || box.bottom > plot.bottom + 12;
    return { x, y: p.y + dy, anchor, text, cost: covered + (outside ? 100 : 0) };
  });
  const best = candidates.reduce((a, b) => (b.cost < a.cost ? b : a));
  return { x: best.x, y: best.y, anchor: best.anchor, text: best.text };
}
