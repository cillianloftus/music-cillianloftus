/**
 * A year of rating days laid out as a calendar: one column per week,
 * Monday at the top, each day shaded by how much was rated. Dates are
 * Dublin dates, as the diary's are.
 */

export interface CalendarDay {
  /** YYYY-MM-DD, Dublin time. */
  date: string;
  count: number;
  /** 0 for nothing rated, then 1–4 from light to strong. */
  level: 0 | 1 | 2 | 3 | 4;
  /** After today: drawn as nothing, so the last column ends at today. */
  future: boolean;
}

export interface Calendar {
  weeks: CalendarDay[][];
  /** The week column where each month's label goes. */
  months: { week: number; label: string }[];
  /** The counts at which each level starts, for the key and readout. */
  levels: number[];
  total: number;
  days: number;
  /** The most days in a row with something rated, and the run up to today (or yesterday). */
  longestRun: number;
  currentRun: number;
}

/** Runs of consecutive days in a set of dates: the longest, and the one reaching today or yesterday. */
export function runsOf(dates: string[], today: string): { longest: number; current: number } {
  const days = new Set(dates);
  let longest = 0;
  for (const d of days) {
    if (days.has(shift(d, -1))) continue; // not the start of a run
    let n = 1;
    while (days.has(shift(d, n))) n++;
    longest = Math.max(longest, n);
  }
  // A run still counts as current until a whole day passes without a rating.
  let end = days.has(today) ? today : days.has(shift(today, -1)) ? shift(today, -1) : null;
  let current = 0;
  while (end && days.has(end)) {
    current++;
    end = shift(end, -1);
  }
  return { longest, current };
}

const ZONE = 'Europe/Dublin';

/** A moment as its Dublin date, YYYY-MM-DD. */
export function dublinDate(at: string | Date, zone = ZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}

/** A YYYY-MM-DD date moved by some days, without time zones getting involved. */
function shift(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0 for Monday through 6 for Sunday. */
function weekday(date: string): number {
  return (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
}

/**
 * Levels from where the busy days fall, not from the single busiest: one
 * day of rating a whole discography would otherwise leave every other day
 * at the faintest shade. Each level starts at a quartile of the days with
 * anything rated.
 */
export function levelsFor(counts: number[]): number[] {
  const busy = counts.filter((c) => c > 0).sort((a, b) => a - b);
  if (busy.length === 0) return [1, 2, 3, 4];
  const at = (q: number) => busy[Math.min(busy.length - 1, Math.floor(q * busy.length))]!;
  const starts = [1, at(0.25), at(0.5), at(0.75)];
  // Strictly rising, so each level is reachable and the key reads in order.
  for (let i = 1; i < starts.length; i++) starts[i] = Math.max(starts[i]!, starts[i - 1]! + 1);
  return starts;
}

/** The year to `today` (a Dublin date) from rating moments: 53 weeks, the last one ending on Sunday. */
export function calendarOf(ratedAt: string[], today: string, weeks = 53): Calendar {
  const counts = new Map<string, number>();
  for (const at of ratedAt) {
    const d = dublinDate(at);
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const lastSunday = shift(today, 6 - weekday(today));
  const first = shift(lastSunday, -(weeks * 7 - 1));
  const inRange = [...counts].filter(([d]) => d >= first && d <= today).map(([, c]) => c);
  const levels = levelsFor(inRange);
  const level = (c: number) => (c === 0 ? 0 : (levels.filter((start) => c >= start).length as 1 | 2 | 3 | 4));

  const grid: CalendarDay[][] = [];
  const months: Calendar['months'] = [];
  const monthName = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' });
  for (let w = 0; w < weeks; w++) {
    const week: CalendarDay[] = [];
    for (let d = 0; d < 7; d++) {
      const date = shift(first, w * 7 + d);
      const count = counts.get(date) ?? 0;
      week.push({ date, count, level: level(count), future: date > today });
      // A month's label sits over the week its first day falls in.
      if (date.endsWith('-01') && date <= today) months.push({ week: w, label: monthName.format(new Date(`${date}T12:00:00Z`)) });
    }
    grid.push(week);
  }
  const runs = runsOf([...counts.keys()].filter((d) => d >= first && d <= today), today);
  return {
    weeks: grid,
    months,
    levels,
    total: inRange.reduce((a, b) => a + b, 0),
    days: inRange.length,
    longestRun: runs.longest,
    currentRun: runs.current,
  };
}
