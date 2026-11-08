/**
 * The stretch of time a recap covers, named by its URL:
 *
 *   /recap                         the last 30 days
 *   /recap/last-7-days             also last-30-days, last-90-days, last-12-months
 *   /recap/this-month              also this-year
 *   /recap/2026-10                 a month
 *   /recap/2026                    a year
 *   /recap/2026-10-03              a day
 *   /recap/2026-09-14..2026-10-02  any days, both ends included
 *   /recap/all                     everything
 *
 * Days are Dublin days: a recap of October starts at midnight on 1
 * October in Dublin, whatever the offset that night. Each range knows the
 * one before it (the previous month, year, or as many days just before),
 * for comparison.
 */

export const ZONE = 'Europe/Dublin';

export type RangeKind = 'rolling' | 'month' | 'year' | 'day' | 'custom' | 'all';

export interface Range {
  slug: string;
  kind: RangeKind;
  /** "Last 30 days", "October 2026", "3–21 Sep 2026". */
  label: string;
  /** First day, local, inclusive. */
  from: string;
  /** Day after the last, local, exclusive. */
  to: string;
  days: number;
  /** UTC instants for querying: [start, end). */
  start: string;
  end: string;
  previous: Range | null;
}

const DAY_MS = 86_400_000;
const offsetFormat = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, timeZoneName: 'longOffset' });
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Minutes Dublin is ahead of UTC at an instant. */
export function zoneOffset(ms: number): number {
  const name = offsetFormat.formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** The Dublin date at an instant, as YYYY-MM-DD. */
export function localDay(ms: number): string {
  return dayFormat.format(new Date(ms));
}

/** The instant a Dublin day begins. */
export function dayStart(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  let at = guess - zoneOffset(guess) * 60_000;
  // Across a change of offset the first guess can be an hour out.
  const again = guess - zoneOffset(at) * 60_000;
  if (again !== at) at = again;
  return at;
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT = MONTHS.map((m) => m.slice(0, 3));

/** "3 Sep 2026", "3–21 Sep 2026", "28 Aug – 3 Sep 2026", "30 Dec 2025 – 2 Jan 2026". */
export function spanLabel(from: string, last: string): string {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ly, lm, ld] = last.split('-').map(Number) as [number, number, number];
  if (from === last) return `${fd} ${SHORT[fm - 1]} ${fy}`;
  if (fy === ly && fm === lm) return `${fd}–${ld} ${SHORT[fm - 1]} ${fy}`;
  if (fy === ly) return `${fd} ${SHORT[fm - 1]} – ${ld} ${SHORT[lm - 1]} ${fy}`;
  return `${fd} ${SHORT[fm - 1]} ${fy} – ${ld} ${SHORT[lm - 1]} ${ly}`;
}

function make(slug: string, kind: RangeKind, label: string, from: string, to: string, previous: Range | null = null): Range {
  return { slug, kind, label, from, to, days: daysBetween(from, to), start: new Date(dayStart(from)).toISOString(), end: new Date(dayStart(to)).toISOString(), previous };
}

function custom(from: string, to: string): Range {
  const last = addDays(to, -1);
  return make(from === last ? from : `${from}..${last}`, from === last ? 'day' : 'custom', spanLabel(from, last), from, to);
}

/** The same number of days just before. */
function before(r: Range): Range {
  const from = addDays(r.from, -r.days);
  return custom(from, r.from);
}

function month(y: number, m: number): Range {
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const to = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return make(from.slice(0, 7), 'month', `${MONTHS[m - 1]} ${y}`, from, to);
}

const year = (y: number) => make(String(y), 'year', String(y), `${y}-01-01`, `${y + 1}-01-01`);

const ROLLING: Record<string, { days?: number; months?: number; label: string }> = {
  'last-7-days': { days: 7, label: 'Last 7 days' },
  'last-30-days': { days: 30, label: 'Last 30 days' },
  'last-90-days': { days: 90, label: 'Last 90 days' },
  'last-12-months': { months: 12, label: 'Last 12 months' },
};

export const DEFAULT_RANGE = 'last-30-days';

/** The range a slug names, or null for one that names nothing. `now` is for tests. */
export function parseRange(slug: string | undefined, now = Date.now(), earliest?: string | null): Range | null {
  const s = (slug ?? '').trim().replace(/\/+$/, '') || DEFAULT_RANGE;
  const today = localDay(now);
  const tomorrow = addDays(today, 1);

  const rolling = ROLLING[s];
  if (rolling) {
    let from: string;
    if (rolling.days) from = addDays(tomorrow, -rolling.days);
    else {
      const [y, m, d] = today.split('-').map(Number) as [number, number, number];
      from = addDays(`${y - 1}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, 1);
    }
    const r = make(s, 'rolling', rolling.label, from, tomorrow);
    return { ...r, previous: before(r) };
  }
  if (s === 'this-month') {
    const [y, m] = today.split('-').map(Number) as [number, number];
    const r = month(y, m);
    return { ...r, slug: s, label: `${MONTHS[m - 1]} so far`, previous: m === 1 ? month(y - 1, 12) : month(y, m - 1) };
  }
  if (s === 'this-year') {
    const y = Number(today.slice(0, 4));
    return { ...year(y), slug: s, label: `${y} so far`, previous: year(y - 1) };
  }
  if (s === 'all') {
    const from = earliest && isDay(earliest) ? earliest : '2000-01-01';
    return make('all', 'all', 'All time', from, tomorrow);
  }
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})$/.exec(s))) {
    const y = Number(m[1]);
    if (y < 1990 || y > 2100) return null;
    return { ...year(y), previous: year(y - 1) };
  }
  if ((m = /^(\d{4})-(\d{2})$/.exec(s))) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12 || y < 1990 || y > 2100) return null;
    return { ...month(y, mo), previous: mo === 1 ? month(y - 1, 12) : month(y, mo - 1) };
  }
  if (isDay(s)) {
    const r = custom(s, addDays(s, 1));
    return { ...r, previous: before(r) };
  }
  if ((m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(s))) {
    let [a, b] = [m[1]!, m[2]!];
    if (!isDay(a) || !isDay(b)) return null;
    if (a > b) [a, b] = [b, a];
    if (daysBetween(a, b) > 366 * 30) return null;
    const r = custom(a, addDays(b, 1));
    return { ...r, previous: before(r) };
  }
  return null;
}

/** The slug for any two days, in either order. */
export function slugFor(from: string, last: string): string {
  const [a, b] = from <= last ? [from, last] : [last, from];
  return a === b ? a : `${a}..${b}`;
}

/** The ranges offered as shortcuts. */
export const PRESETS = ['last-7-days', 'last-30-days', 'this-month', 'last-90-days', 'this-year', 'last-12-months', 'all'] as const;
