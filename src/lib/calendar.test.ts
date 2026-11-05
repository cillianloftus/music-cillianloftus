import { describe, expect, it } from 'vitest';
import { calendarOf, dublinDate, levelsFor } from './calendar';

describe('dublinDate', () => {
  it('uses Dublin time, so a late summer rating stays on its evening', () => {
    // 23:30 UTC on 1 July is 00:30 on 2 July in Dublin (summer time).
    expect(dublinDate('2026-07-01T23:30:00Z')).toBe('2026-07-02');
    // In winter Dublin is on UTC.
    expect(dublinDate('2026-01-01T23:30:00Z')).toBe('2026-01-01');
  });
});

describe('levelsFor', () => {
  it('spreads levels over the busy days rather than the single busiest', () => {
    // Mostly a few a day, and one day of rating a whole discography.
    const levels = levelsFor([1, 1, 2, 2, 3, 3, 4, 5, 6, 120]);
    expect(levels[0]).toBe(1);
    expect(levels[3]).toBeLessThan(10);
  });

  it('keeps every level reachable when the counts are all the same', () => {
    expect(levelsFor([1, 1, 1, 1])).toEqual([1, 2, 3, 4]);
  });
});

describe('calendarOf', () => {
  const today = '2026-11-05'; // a Thursday
  const cal = calendarOf(['2026-11-05T10:00:00Z', '2026-11-05T11:00:00Z', '2026-11-02T09:00:00Z', '2024-01-01T09:00:00Z'], today);

  it('lays out 53 weeks of seven days, Monday first, ending the week of today', () => {
    expect(cal.weeks).toHaveLength(53);
    expect(cal.weeks.every((w) => w.length === 7)).toBe(true);
    const last = cal.weeks.at(-1)!;
    expect(last[0]!.date).toBe('2026-11-02'); // Monday
    expect(last[6]!.date).toBe('2026-11-08'); // Sunday
    expect(last.filter((d) => d.future).map((d) => d.date)).toEqual(['2026-11-06', '2026-11-07', '2026-11-08']);
  });

  it('counts each day and leaves out ratings older than the year shown', () => {
    const day = (date: string) => cal.weeks.flat().find((d) => d.date === date)!;
    expect(day('2026-11-05').count).toBe(2);
    expect(day('2026-11-02').count).toBe(1);
    expect(day('2026-11-03').level).toBe(0);
    expect(cal.total).toBe(3);
    expect(cal.days).toBe(2);
  });

  it('labels each month over the week its first day is in', () => {
    const nov = cal.months.find((m) => m.label === 'Nov')!;
    expect(cal.weeks[nov.week]!.some((d) => d.date === '2026-11-01')).toBe(true);
  });
});
