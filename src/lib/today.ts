/**
 * What is worth listening to today: birthdays of artists in the library,
 * albums and singles turning a year older, groups' anniversaries, and
 * something not rated yet. Today is Dublin's today; the picks look two weeks
 * ahead, ordered by how much they are likely to matter (care), and a day's
 * unrated pick stays the same all day.
 */

import { env } from 'cloudflare:workers';

/** Two weeks ahead: a big anniversary is worth knowing of before the day. */
export const WINDOW_DAYS = 14;
/** The calendar's picks kept, by how much they are likely to matter (care below). */
export const MAX_CALENDAR_PICKS = 24;

/** A version of something rather than the thing: remixes, edits, live takes. */
const VERSION = /\b(remix(es|ed)?|mix|edit|version|live|acoustic|instrumental|sped[ -]?up|slowed|reverb|remaster(ed)?|demo|rework|flip|bootleg)\b/i;

/**
 * How much Cillian is likely to care about a calendar pick, for its place
 * in the row. What it is (an album over a single, a single over a remix; a
 * birthday counts like an album), how he rated it, how much its artist
 * matters to him, and how soon: today is worth a lot, and each day further
 * off a little less. So a single out today edges a loved album two weeks
 * off, and loses to it once it is a few days away.
 */
export function care(p: Pick & { score?: number | null }): number {
  const what =
    p.kind === 'birthday' || p.kind === 'formed'
      ? 1.5
      : ({ album: 2, mixtape: 1.8, ep: 1.5, single: 0.5 } as Record<string, number>)[p.type ?? ''] ?? 0.8;
  const version = p.kind === 'anniversary' && VERSION.test(p.title) ? -1.5 : 0;
  const loved = p.score == null ? 0 : (Math.max(0, p.score - 70) / 10) * 1.2;
  const soon = p.daysAway === 0 ? 3 : p.daysAway === 1 ? 1.5 : -p.daysAway * 0.2;
  return what + version + loved + (p.affinity ?? 0) * 0.5 + soon + (p.milestone ? 1 : 0);
}
const ZONE = 'Europe/Dublin';

export type PickKind = 'birthday' | 'formed' | 'anniversary' | 'unrated' | 'month' | 'revisit' | 'favourite' | 'artist' | 'genre';

/** Picks the row always tries to reach, filling with other reasons when the calendar is quiet. */
export const MIN_PICKS = 5;

export interface Pick {
  kind: PickKind;
  id: string;
  title: string;
  /** The artist line, for albums. */
  by: string | null;
  /** Years being marked: an age, or how long since release. */
  years: number | null;
  /** 0 is today. */
  daysAway: number;
  /** A round number worth making a fuss of: 1, 5, 10, 15, 20, 25... */
  milestone: boolean;
  artKey: string | null;
  imageKey: string | null;
  spotifyId: string | null;
  type: string | null;
  /** For the filler kinds: why it is here, in a few words. */
  reason?: string;
  /** For the filler kinds: where its title links. */
  href?: string;
  /** How much the artist matters here (see affinity); orders the row. */
  affinity?: number;
}

/**
 * How much an artist matters to Cillian, from the library: how highly their
 * tracks are rated, how many have been rated, and how much of theirs is
 * here. Logarithms, so the tenth album counts for less than the second.
 */
export function affinity(stats: { average: number | null; rated: number; releases: number }): number {
  const liking = stats.average == null ? 0 : Math.max(0, stats.average - 70) / 10;
  return liking * 1.5 + Math.log1p(stats.rated) * 1.2 + Math.log1p(stats.releases);
}

/**
 * Per artist: average track score, rated tracks, releases here. Grouped in
 * one pass each: as subqueries per artist it re-scored every rating for
 * each of thousands of artists.
 */
const ARTIST_STATS = `
  SELECT a.id, scored.average, coalesce(scored.rated, 0) AS rated, coalesce(own.releases, 0) AS releases
  FROM artist a
  LEFT JOIN (SELECT c.artist_id, avg(s.quality_score) AS average, count(*) AS rated
             FROM artist_credit c JOIN v_recording_score s ON s.recording_id = c.entity_id AND s.user_id = ?1
             WHERE c.entity_type = 'recording' AND c.role = 'primary' GROUP BY c.artist_id) scored ON scored.artist_id = a.id
  LEFT JOIN (SELECT artist_id, count(*) AS releases FROM artist_credit
             WHERE entity_type = 'release_group' AND role = 'primary' GROUP BY artist_id) own ON own.artist_id = a.id`;

/** Today's date in Dublin, as YYYY-MM-DD. */
export function todayIn(now: Date = new Date(), zone = ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Days from today to the next time a date's month and day come round, and
 * how many years it will be then. 29 February is marked on 28 February in
 * other years.
 */
export function nextOccurrence(date: string, today: string): { days: number; years: number } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  const base = Date.UTC(ty, tm - 1, td);
  const on = (year: number) => {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return Date.UTC(year, m - 1, m === 2 && d === 29 && !leap ? 28 : d);
  };
  let year = ty;
  if (on(year) < base) year += 1;
  return { days: Math.round((on(year) - base) / 86_400_000), years: year - y };
}

export const isMilestone = (years: number) => years === 1 || (years > 0 && years % 5 === 0);

/** A small stable hash of a string: the same day picks the same album. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export async function todayPicks(
  viewerId: string | null,
  options: { now?: Date; includeUnrated?: boolean; /** Off: the calendar only. */ fill?: boolean } = {},
): Promise<Pick[]> {
  const today = todayIn(options.now);
  const [people, albums, unrated, stats] = await env.DB.batch([
    // Artists who are main artists here, with a day-precise begin date.
    env.DB.prepare(
      `SELECT a.id, a.name AS title, a.kind, a.begin_date AS date, a.spotify_id,
              (SELECT i.key FROM artist_image i WHERE i.artist_id = a.id AND i.hidden = 0 ORDER BY i.position LIMIT 1) AS image_key,
              (SELECT r.art_key FROM artist_credit c
               JOIN v_release_group_canonical gc ON gc.release_group_id = c.entity_id
               JOIN release r ON r.id = gc.release_id
               JOIN release_group g ON g.id = c.entity_id
               WHERE c.artist_id = a.id AND c.entity_type = 'release_group' AND c.role = 'primary'
               ORDER BY g.first_release_date DESC LIMIT 1) AS art_key
       FROM artist a
       WHERE a.begin_precision = 'day' AND a.end_date IS NULL
         AND EXISTS (SELECT 1 FROM artist_credit c WHERE c.artist_id = a.id AND c.role = 'primary' AND c.entity_type = 'release_group')`,
    ),
    env.DB.prepare(
      `SELECT g.id, g.title, g.type, g.first_release_date AS date, g.spotify_id, r.art_key,
              (SELECT group_concat(a.name, ', ') FROM artist_credit c JOIN artist a ON a.id = c.artist_id
               WHERE c.entity_type = 'release_group' AND c.entity_id = g.id AND c.role = 'primary') AS by,
              (SELECT c.artist_id FROM artist_credit c
               WHERE c.entity_type = 'release_group' AND c.entity_id = g.id AND c.role = 'primary' ORDER BY c.position LIMIT 1) AS artist_id
       FROM release_group g
       LEFT JOIN v_release_group_canonical gc ON gc.release_group_id = g.id
       LEFT JOIN release r ON r.id = gc.release_id
       WHERE g.date_precision = 'day' AND g.status = 'released'`,
    ),
    // Albums with no rating of any kind from this viewer.
    env.DB.prepare(
      `SELECT g.id, g.title, g.type, g.spotify_id, r.art_key,
              (SELECT group_concat(a.name, ', ') FROM artist_credit c JOIN artist a ON a.id = c.artist_id
               WHERE c.entity_type = 'release_group' AND c.entity_id = g.id AND c.role = 'primary') AS by
       FROM release_group g
       LEFT JOIN v_release_group_canonical gc ON gc.release_group_id = g.id
       LEFT JOIN release r ON r.id = gc.release_id
       WHERE g.status = 'released'
         AND NOT EXISTS (SELECT 1 FROM v_release_score s WHERE s.release_group_id = g.id AND s.user_id = ?1)
       ORDER BY g.id`,
    ).bind(viewerId),
    env.DB.prepare(ARTIST_STATS).bind(viewerId),
  ]);

  type Row = Record<string, string | null>;
  const picks: Pick[] = [];
  const artistCare = new Map(
    ((stats?.results ?? []) as { id: string; average: number | null; rated: number; releases: number }[]).map((a) => [a.id, affinity(a)]),
  );

  for (const p of (people?.results ?? []) as Row[]) {
    const { days, years } = nextOccurrence(p.date!, today);
    if (days >= WINDOW_DAYS || years <= 0) continue;
    const birthday = p.kind === 'person' || p.kind === 'character';
    picks.push({
      kind: birthday ? 'birthday' : 'formed',
      id: p.id!,
      title: p.title!,
      by: null,
      years,
      daysAway: days,
      milestone: birthday ? years % 10 === 0 : isMilestone(years),
      affinity: artistCare.get(p.id!) ?? 0,
      artKey: p.art_key,
      imageKey: p.image_key,
      spotifyId: p.spotify_id,
      type: null,
    });
  }

  for (const a of (albums?.results ?? []) as Row[]) {
    const { days, years } = nextOccurrence(a.date!, today);
    if (days >= WINDOW_DAYS || years <= 0) continue;
    picks.push({
      kind: 'anniversary',
      id: a.id!,
      title: a.title!,
      by: a.by,
      years,
      daysAway: days,
      milestone: isMilestone(years),
      artKey: a.art_key,
      imageKey: null,
      spotifyId: a.spotify_id,
      type: a.type,
      affinity: artistCare.get(a.artist_id ?? '') ?? 0,
    });
  }

  // How each release in the window was rated: only those, not every album.
  const releaseIds = picks.filter((p) => p.kind === 'anniversary').map((p) => p.id);
  const scored = releaseIds.length
    ? (
        await env.DB.prepare(
          `SELECT release_group_id AS id, quality_score AS score FROM v_release_score
           WHERE user_id = ?1 AND release_group_id IN (SELECT value FROM json_each(?2))`,
        )
          .bind(viewerId, JSON.stringify(releaseIds))
          .all<{ id: string; score: number | null }>()
      ).results
    : [];
  const scores = new Map(scored.map((r) => [r.id, r.score]));

  // Most likely to matter first (care, above); only the best of them kept.
  const ranked = picks
    .map((p) => ({ p, weight: care({ ...p, score: scores.get(p.id) ?? null }) }))
    .sort((x, y) => y.weight - x.weight)
    .slice(0, MAX_CALENDAR_PICKS)
    .map((x) => x.p);
  picks.length = 0;
  picks.push(...ranked);

  // One thing each: an album marked twice (an anniversary and unrated) shows once.
  const seen = new Set(picks.map((p) => p.id));
  const add = (pick: Pick) => {
    if (seen.has(pick.id)) return;
    seen.add(pick.id);
    picks.push(pick);
  };

  // One album not rated yet, never one already in the row.
  const pool = ((unrated?.results ?? []) as Row[]).filter((u) => !seen.has(u.id!));
  if (options.includeUnrated && pool.length > 0) {
    const u = pool[hash(today) % pool.length]!;
    add({
      kind: 'unrated',
      id: u.id!,
      title: u.title!,
      by: u.by,
      years: null,
      daysAway: 0,
      milestone: false,
      artKey: u.art_key,
      imageKey: null,
      spotifyId: u.spotify_id,
      type: u.type,
    });
  }

  if (options.fill !== false && picks.length < MIN_PICKS) for (const filler of await fillers(viewerId, today)) {
    if (picks.length >= MIN_PICKS) break;
    add(filler);
  }
  return picks;
}

/**
 * Other reasons to put something in front of Cillian today, for when the
 * calendar is quiet. Each kind offers a few candidates, chosen by the date
 * so the row is stable through a day and different the next; they are
 * interleaved so the row mixes kinds rather than showing five of one.
 */
async function fillers(viewerId: string | null, today: string): Promise<Pick[]> {
  const month = today.slice(5, 7);
  const [later, revisit, favourites, artists, genres] = await env.DB.batch([
    // Out this month in another year, further off than the week's window.
    env.DB.prepare(
      `SELECT g.id, g.title, g.type, g.first_release_date AS date, g.spotify_id, r.art_key,
              (SELECT group_concat(a.name, ', ') FROM artist_credit c JOIN artist a ON a.id = c.artist_id
               WHERE c.entity_type = 'release_group' AND c.entity_id = g.id AND c.role = 'primary') AS by
       FROM release_group g
       LEFT JOIN v_release_group_canonical gc ON gc.release_group_id = g.id
       LEFT JOIN release r ON r.id = gc.release_id
       WHERE g.status = 'released' AND g.date_precision IN ('day', 'month') AND substr(g.first_release_date, 6, 2) = ?1
         AND substr(g.first_release_date, 1, 4) < substr(?2, 1, 4)`,
    ).bind(month, today),
    // Albums loved once and not rated for a long while: time to hear them again.
    env.DB.prepare(
      `SELECT g.id, g.title, g.type, g.spotify_id, r.art_key, s.quality_score AS score,
              (SELECT max(x.rated_at) FROM rating x WHERE x.user_id = ?1 AND x.entity_type = 'release_group' AND x.entity_id = g.id) AS rated_at,
              (SELECT group_concat(a.name, ', ') FROM artist_credit c JOIN artist a ON a.id = c.artist_id
               WHERE c.entity_type = 'release_group' AND c.entity_id = g.id AND c.role = 'primary') AS by
       FROM v_release_score s JOIN release_group g ON g.id = s.release_group_id
       LEFT JOIN v_release_group_canonical gc ON gc.release_group_id = g.id
       LEFT JOIN release r ON r.id = gc.release_id
       WHERE s.user_id = ?1 AND s.quality_score >= 85
       ORDER BY rated_at`,
    ).bind(viewerId),
    // Favourite tracks.
    env.DB.prepare(
      `SELECT r.id, r.title, r.spotify_id, x.art_key, s.quality_score AS score, ra.release_group_id AS album_id,
              (SELECT group_concat(a.name, ', ') FROM artist_credit c JOIN artist a ON a.id = c.artist_id
               WHERE c.entity_type = 'recording' AND c.entity_id = r.id AND c.role = 'primary') AS by
       FROM v_recording_score s JOIN recording r ON r.id = s.recording_id
       LEFT JOIN v_recording_album ra ON ra.recording_id = r.id
       LEFT JOIN v_release_group_canonical gc ON gc.release_group_id = ra.release_group_id
       LEFT JOIN release x ON x.id = gc.release_id
       WHERE s.user_id = ?1 AND s.quality_score >= 90
       ORDER BY s.personal_score DESC LIMIT 40`,
    ).bind(viewerId),
    // Artists with plenty here.
    env.DB.prepare(
      `SELECT a.id, a.name AS title, a.spotify_id,
              (SELECT i.key FROM artist_image i WHERE i.artist_id = a.id AND i.hidden = 0 ORDER BY i.position LIMIT 1) AS image_key,
              count(*) AS releases
       FROM artist a JOIN artist_credit c ON c.artist_id = a.id AND c.entity_type = 'release_group' AND c.role = 'primary'
       GROUP BY a.id HAVING count(*) >= 2
       ORDER BY releases DESC LIMIT 20`,
    ),
    // Genres with enough in them to dig into.
    env.DB.prepare(
      `SELECT g.id, g.name AS title, count(DISTINCT vg.recording_id) AS tracks
       FROM genre g JOIN v_recording_genre vg ON vg.genre_id = g.id
       GROUP BY g.id HAVING tracks >= 5
       ORDER BY tracks DESC LIMIT 30`,
    ),
  ]);

  type Row = Record<string, string | number | null>;
  const rows = (r: D1Result | undefined) => (r?.results ?? []) as Row[];
  const s = (v: unknown) => (v == null ? null : String(v));
  // A day's choice from each list, rotating through it day by day.
  const choose = (list: Row[], salt: string, n = 2) => {
    if (list.length === 0) return [];
    const start = hash(`${today}${salt}`) % list.length;
    return Array.from({ length: Math.min(n, list.length) }, (_, k) => list[(start + k) % list.length]!);
  };
  const blank = { years: null, daysAway: 0, milestone: false, imageKey: null, spotifyId: null, type: null, artKey: null, by: null };
  const monthName = new Date(`${today}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
  const ago = (iso: string | null) => {
    if (!iso) return null;
    const months = Math.round((Date.parse(today) - Date.parse(iso)) / (30.4 * 86_400_000));
    return months >= 2 ? (months >= 12 ? `${Math.floor(months / 12)} ${Math.floor(months / 12) === 1 ? 'year' : 'years'}` : `${months} months`) : null;
  };

  const lists: Pick[][] = [
    choose(rows(later), 'month').map((a) => ({
      ...blank,
      kind: 'month' as const,
      id: s(a.id)!,
      title: s(a.title)!,
      by: s(a.by),
      artKey: s(a.art_key),
      spotifyId: s(a.spotify_id),
      type: s(a.type),
      reason: `Out in ${monthName} ${s(a.date)!.slice(0, 4)}`,
    })),
    choose(rows(revisit).slice(0, 8), 'revisit').map((a) => ({
      ...blank,
      kind: 'revisit' as const,
      id: s(a.id)!,
      title: s(a.title)!,
      by: s(a.by),
      artKey: s(a.art_key),
      spotifyId: s(a.spotify_id),
      type: s(a.type),
      reason: ago(s(a.rated_at)) ? `You gave it ${Math.round(Number(a.score))}, ${ago(s(a.rated_at))} ago` : `One of your best, at ${Math.round(Number(a.score))}`,
    })),
    choose(rows(favourites), 'favourite').map((t) => ({
      ...blank,
      kind: 'favourite' as const,
      id: s(t.id)!,
      title: s(t.title)!,
      by: s(t.by),
      artKey: s(t.art_key),
      spotifyId: s(t.spotify_id),
      reason: `A favourite: ${Math.round(Number(t.score))}`,
      href: `/track/${s(t.id)}`,
    })),
    choose(rows(artists), 'artist', 1).map((a) => ({
      ...blank,
      kind: 'artist' as const,
      id: s(a.id)!,
      title: s(a.title)!,
      imageKey: s(a.image_key),
      spotifyId: s(a.spotify_id),
      reason: `A day with them: ${a.releases} releases here`,
      href: `/artist/${s(a.id)}`,
    })),
    choose(rows(genres), 'genre', 1).map((g) => ({
      ...blank,
      kind: 'genre' as const,
      id: s(g.id)!,
      title: s(g.title)!,
      reason: `A genre to dig into: ${g.tracks} tracks`,
      href: `/genre/${s(g.id)}`,
    })),
  ];
  // Interleave: one of each kind, then the next of each.
  const out: Pick[] = [];
  for (let round = 0; round < 2; round++) for (const list of lists) if (list[round]) out.push(list[round]!);
  return out;
}

/** "today", "tomorrow", "on Friday" within the week; past it, the date: "on 19 November". */
export function whenText(daysAway: number, now: Date = new Date()): string {
  if (daysAway === 0) return 'today';
  if (daysAway === 1) return 'tomorrow';
  const day = new Date(now.getTime() + daysAway * 86_400_000);
  const format = daysAway < 7 ? { weekday: 'long' as const } : { day: 'numeric' as const, month: 'long' as const };
  return `on ${new Intl.DateTimeFormat('en-GB', { ...format, timeZone: ZONE }).format(day)}`;
}

export const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};
