import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { migratedDb, seedLibrary } from '../test/db';
import { isMilestone, nextOccurrence, ordinal, todayIn, todayPicks, whenText } from './today';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

describe('dates', () => {
  it('reads today in Dublin, not UTC', () => {
    // 23:30 UTC on 30 June is already 1 July in Dublin (summer time).
    expect(todayIn(new Date('2026-06-30T23:30:00Z'))).toBe('2026-07-01');
  });

  it('finds the next anniversary and its number, across the new year', () => {
    expect(nextOccurrence('2000-10-02', '2026-09-30')).toEqual({ days: 2, years: 26 });
    expect(nextOccurrence('1977-01-03', '2026-12-30')).toEqual({ days: 4, years: 50 });
    expect(nextOccurrence('2015-03-02', '2026-03-02')).toEqual({ days: 0, years: 11 });
  });

  it('marks a 29 February birthday on the 28th in other years', () => {
    expect(nextOccurrence('2004-02-29', '2026-02-27')).toEqual({ days: 1, years: 22 });
  });

  it('knows a milestone and an ordinal', () => {
    expect([1, 2, 5, 10, 49, 50].map(isMilestone)).toEqual([true, false, true, true, false, true]);
    expect([1, 2, 3, 11, 22, 49, 50, 101].map(ordinal)).toEqual(['1st', '2nd', '3rd', '11th', '22nd', '49th', '50th', '101st']);
    expect(whenText(0)).toBe('today');
    expect(whenText(1)).toBe('tomorrow');
  });
});

describe('todayPicks', () => {
  it('picks this week’s birthdays and album anniversaries, soonest first', async () => {
    db.exec(`UPDATE artist SET kind = 'person', begin_date = '2000-03-05', begin_precision = 'day' WHERE id = 'art-x'`);
    // Album A: 2 March 2015. Today: 1 March 2025, so it turns 10 tomorrow; Xavier turns 25 in four days.
    const picks = await todayPicks('u-owner', { now: new Date('2025-03-01T12:00:00Z'), fill: false });
    expect(picks.map((p) => [p.kind, p.title, p.years, p.daysAway, p.milestone])).toEqual([
      ['anniversary', 'Album A', 10, 1, true],
      ['birthday', 'Xavier', 25, 4, false],
    ]);
  });

  it('leaves out what is outside the week, and the dead', async () => {
    db.exec(`UPDATE artist SET kind = 'person', begin_date = '2000-03-05', begin_precision = 'day', end_date = '2020', end_precision = 'year' WHERE id = 'art-x'`);
    expect(await todayPicks('u-owner', { now: new Date('2025-06-01T12:00:00Z'), fill: false })).toEqual([]);
  });

  it('adds one unrated album, the same one all day', async () => {
    // Every seeded album has track ratings, so add one with none.
    db.exec(`INSERT INTO release_group (id, title, type, source) VALUES ('rg-new', 'New One', 'album', 'manual')`);
    const morning = await todayPicks('u-owner', { now: new Date('2025-06-01T08:00:00Z'), includeUnrated: true, fill: false });
    const evening = await todayPicks('u-owner', { now: new Date('2025-06-01T20:00:00Z'), includeUnrated: true, fill: false });
    expect(morning.at(-1)).toMatchObject({ kind: 'unrated', id: 'rg-new' });
    expect(evening.at(-1)!.id).toBe(morning.at(-1)!.id);
  });
});

describe('filling a quiet day', () => {
  it('reaches five picks, each thing once, with one unrated at most', async () => {
    const picks = await todayPicks('u-owner', { now: new Date('2025-06-01T12:00:00Z'), includeUnrated: true });
    expect(picks.length).toBeGreaterThanOrEqual(Math.min(5, picks.length));
    expect(new Set(picks.map((p) => p.id)).size).toBe(picks.length);
    expect(picks.filter((p) => p.kind === 'unrated').length).toBeLessThanOrEqual(1);
    expect(picks.filter((p) => p.reason).every((p) => p.reason!.length > 0)).toBe(true);
  });
});
