import { describe, expect, it } from 'vitest';
import { buildRecap, type RecapListen } from './build';
import { dayStart, parseRange, slugFor, spanLabel } from './range';

// 8 Nov 2026, 13:00 in Dublin (GMT).
const NOW = Date.parse('2026-11-08T13:00:00Z');

describe('ranges', () => {
  it('starts a Dublin day at Dublin midnight, summer and winter', () => {
    expect(new Date(dayStart('2026-07-01')).toISOString()).toBe('2026-06-30T23:00:00.000Z');
    expect(new Date(dayStart('2026-12-01')).toISOString()).toBe('2026-12-01T00:00:00.000Z');
    // The clocks went back on 25 Oct 2026.
    expect(new Date(dayStart('2026-10-25')).toISOString()).toBe('2026-10-24T23:00:00.000Z');
    expect(new Date(dayStart('2026-10-26')).toISOString()).toBe('2026-10-26T00:00:00.000Z');
  });

  it('reads every kind of slug', () => {
    expect(parseRange(undefined, NOW)).toMatchObject({ slug: 'last-30-days', from: '2026-10-10', to: '2026-11-09', days: 30 });
    expect(parseRange('last-7-days', NOW)).toMatchObject({ from: '2026-11-02', to: '2026-11-09', previous: { from: '2026-10-26', to: '2026-11-02' } });
    expect(parseRange('2026-10', NOW)).toMatchObject({ kind: 'month', label: 'October 2026', from: '2026-10-01', to: '2026-11-01', days: 31, previous: { label: 'September 2026' } });
    expect(parseRange('2026-01', NOW)!.previous).toMatchObject({ label: 'December 2025' });
    expect(parseRange('2025', NOW)).toMatchObject({ kind: 'year', from: '2025-01-01', to: '2026-01-01', previous: { slug: '2024' } });
    expect(parseRange('this-month', NOW)).toMatchObject({ label: 'November so far', previous: { label: 'October 2026' } });
    expect(parseRange('2026-10-03', NOW)).toMatchObject({ kind: 'day', label: '3 Oct 2026', days: 1, previous: { from: '2026-10-02' } });
    expect(parseRange('2026-10-21..2026-09-14', NOW)).toMatchObject({ kind: 'custom', slug: '2026-09-14..2026-10-21', label: '14 Sep – 21 Oct 2026', days: 38 });
    expect(parseRange('all', NOW, '2019-04-02')).toMatchObject({ from: '2019-04-02', to: '2026-11-09', previous: null });
  });

  it('refuses what names no range', () => {
    for (const bad of ['2026-13', '2026-02-30', 'yesterday', '12', '2026-01-01..nope']) expect(parseRange(bad, NOW)).toBeNull();
  });

  it('labels spans compactly', () => {
    expect(spanLabel('2025-12-30', '2026-01-02')).toBe('30 Dec 2025 – 2 Jan 2026');
    expect(slugFor('2026-03-05', '2026-03-01')).toBe('2026-03-01..2026-03-05');
  });
});

const at = (iso: string) => Date.parse(iso);
let n = 0;
function play(iso: string, song: string, artist: string, extra: Partial<RecapListen> = {}): RecapListen {
  n += 1;
  return { at: at(iso), ms: 200_000, estimated: false, source: 'spotify_export', song: `${artist}|${song}`, artist, album: `n:${artist}|album`, genres: [], score: null, recording: null, skipped: false, shuffle: false, platform: 'android', ...extra };
}

describe('building a recap', () => {
  const listens = [
    play('2026-10-01T08:00:00Z', 'alright', 'kendrick', { genres: ['g-hiphop'], score: 92, recording: 'r1', shuffle: true }),
    play('2026-10-01T08:04:00Z', 'alright', 'kendrick', { genres: ['g-hiphop'], score: 92, recording: 'r1' }),
    play('2026-10-01T08:08:00Z', 'alright', 'kendrick', { genres: ['g-hiphop'], score: 92, recording: 'r1' }),
    play('2026-10-02T23:30:00Z', 'holocene', 'bon iver', { platform: 'windows', recording: 'r2' }), // 00:30 in Dublin, 3 Oct
    play('2026-10-05T12:00:00Z', 'new song', 'new artist', { source: 'lastfm', estimated: true, skipped: null, shuffle: null, platform: null }),
  ];
  const recap = buildRecap({
    listens,
    short: [{ at: at('2026-10-05T12:10:00Z'), song: 'kendrick|alright', artist: 'kendrick' }],
    knownSongs: new Set(['kendrick|alright', 'bon iver|holocene']),
    knownArtists: new Set(['kendrick', 'bon iver']),
    from: '2026-10-01',
    to: '2026-11-01',
    duplicates: 2,
  });

  it('totals', () => {
    expect(recap.totals).toMatchObject({ plays: 5, songs: 3, artists: 3, albums: 3, activeDays: 3, days: 31 });
    expect(recap.totals.minutes).toBeCloseTo(5 * 200_000 / 60_000, 1);
    expect(recap.totals.estimatedShare).toBeCloseTo(0.2);
    expect(recap.duplicates).toBe(2);
  });

  it('ranks songs and artists, and marks what was new', () => {
    expect(recap.songs[0]).toMatchObject({ key: 'kendrick|alright', plays: 3, score: 92, isNew: false });
    expect(recap.songs.find((s) => s.key === 'new artist|new song')).toMatchObject({ isNew: true });
    expect(recap.artists[0]).toMatchObject({ key: 'kendrick', songs: 1, topSong: 'kendrick|alright' });
    expect(recap.discoveries).toMatchObject({ songs: 1, artists: 1 });
  });

  it('places listening on Dublin’s clock', () => {
    // 08:00 UTC on 1 Oct is 09:00 in Dublin (summer time).
    expect(recap.hours[9]).toBeGreaterThan(0);
    expect(recap.hours[0]).toBeCloseTo(200_000 / 60_000, 1); // the 00:30 listen
    expect(recap.lateShare).toBeCloseTo(0.2);
    expect(recap.biggestDay).toMatchObject({ day: '2026-10-01', plays: 3, song: 'kendrick|alright' });
  });

  it('finds runs, sessions and repeats', () => {
    expect(recap.streak).toMatchObject({ days: 1 });
    expect(recap.session).toMatchObject({ plays: 3 });
    expect(recap.repeat).toMatchObject({ song: 'kendrick|alright', day: '2026-10-01', plays: 3 });
  });

  it('counts skips from the export and short streams, and shuffle where known', () => {
    expect(recap.skips).toMatchObject({ streams: 5, skipped: 1 });
    expect(recap.shuffleShare).toBeCloseTo(1 / 4);
    expect(recap.platforms.map((p) => p.key)).toEqual(['android', 'windows']);
  });

  it('compares ratings with listening', () => {
    expect(recap.ratings.ratedShare).toBeCloseTo(3 / 5);
    expect(recap.ratings.average).toBe(92);
    expect(recap.ratings.unrated.map((s) => s.key)).toEqual(['bon iver|holocene']);
    expect(recap.genres).toEqual([{ key: 'g-hiphop', plays: 3, minutes: 10 }]);
  });

  it('draws days for a month, weeks for a year', () => {
    expect(recap.series.unit).toBe('day');
    expect(recap.series.buckets).toHaveLength(31);
    const year = buildRecap({ listens, short: [], knownSongs: null, knownArtists: null, from: '2026-01-01', to: '2027-01-01', duplicates: 0 });
    expect(year.series.unit).toBe('week');
    expect(year.months.map((m) => m.month)).toEqual(['2026-10']);
    expect(year.discoveries).toBeNull();
  });

  it('is empty, not broken, with nothing to count', () => {
    const empty = buildRecap({ listens: [], short: [], knownSongs: new Set(), knownArtists: new Set(), from: '2026-10-01', to: '2026-11-01', duplicates: 0 });
    expect(empty.totals.plays).toBe(0);
    expect(empty.biggestDay).toBeNull();
    expect(empty.skips).toBeNull();
  });
});
