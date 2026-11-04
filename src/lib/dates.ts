/**
 * Partial dates. Stored as an ISO 8601 prefix whose length matches its
 * precision ('1982', '1982-11', '1982-11-30'), so they sort and compare
 * correctly as plain text. See migrations/0001.
 */

export type DatePrecision = 'day' | 'month' | 'year' | 'unknown';

export interface PartialDate {
  date: string | null;
  precision: DatePrecision;
}

const UNKNOWN: PartialDate = { date: null, precision: 'unknown' };

/** Parse a possibly partial ISO date, as MusicBrainz and Spotify return them. */
export function parsePartialDate(input: string | null | undefined): PartialDate {
  if (!input) return UNKNOWN;
  const value = input.trim();

  if (/^\d{4}$/.test(value)) return { date: value, precision: 'year' };

  if (/^\d{4}-\d{2}$/.test(value)) {
    const month = Number(value.slice(5, 7));
    return month >= 1 && month <= 12 ? { date: value, precision: 'month' } : UNKNOWN;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // Reject impossible days (1982-02-30) the same way the database does.
    const parsed = new Date(`${value}T00:00:00Z`);
    const valid = !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    return valid ? { date: value, precision: 'day' } : parsePartialDate(value.slice(0, 7));
  }

  return UNKNOWN;
}

const monthName = new Intl.DateTimeFormat('en-IE', { month: 'long', timeZone: 'UTC' });
const fullDate = new Intl.DateTimeFormat('en-IE', { dateStyle: 'long', timeZone: 'UTC' });

/** Human form at exactly the stored precision: never invents a day. */
export function formatPartialDate(date: string | null, precision: DatePrecision): string | null {
  if (!date || precision === 'unknown') return null;
  if (precision === 'year') return date;
  if (precision === 'month') {
    const d = new Date(`${date}-01T00:00:00Z`);
    return `${monthName.format(d)} ${date.slice(0, 4)}`;
  }
  return fullDate.format(new Date(`${date}T00:00:00Z`));
}

export function yearOf(date: string | null): string | null {
  return date ? date.slice(0, 4) : null;
}
