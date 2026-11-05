/**
 * Finding patterns in the ratings nobody thought to ask about.
 *
 * Nothing here is a fixed chart. Every rated track is described by what is
 * known about it (who produced it, who wrote it, its genres, label, year,
 * length, place on the album, guests, plays, the artist's age, the axes,
 * when it was rated), and every group those facts form is compared with
 * everything else, every number is correlated with the score, and every
 * album is searched for the track that doesn't fit. Each candidate gets a
 * strength (roughly a t statistic: how far from the rest, against how much
 * the scores vary and how many tracks back it), weak ones are dropped, and
 * the strongest few, spread across different kinds, are written up as
 * sentences. So the page says whatever the data says, and changes as the
 * ratings do.
 *
 * The same engine runs over one artist's tracks for their page.
 */

import { env } from 'cloudflare:workers';
import { byLibrary } from './library-cache';

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export interface Credit {
  id: string;
  name: string;
  role: string;
  label: string;
  family: string;
  position: number;
  born: string | null;
}

export interface TrackFact {
  id: string;
  title: string;
  score: number;
  ratedAt: string | null;
  lengthMs: number | null;
  albumId: string | null;
  albumTitle: string | null;
  albumType: string | null;
  released: string | null;
  position: number | null;
  size: number | null;
  /** On the album only in a deluxe or other edition, not the standard one. */
  extra: boolean;
  label: string | null;
  credits: Credit[];
  genres: { id: string; name: string }[];
  plays: number;
  axes: { production: number | null; songwriting: number | null; lyrics: number | null; performance: number | null };
  /** The quick gut score (out of 100) given alongside a considered rating, if any. */
  gut: number | null;
}

interface Row {
  id: string;
  title: string;
  score: number;
  rated_at: string | null;
  length_ms: number | null;
  album_id: string | null;
  album_title: string | null;
  album_type: string | null;
  released: string | null;
  position: number | null;
  size: number | null;
  on_album: number;
  label: string | null;
  credits: string | null;
  genres: string | null;
  plays: number;
  production: number | null;
  songwriting: number | null;
  lyrics: number | null;
  performance: number | null;
  gut_score: number | null;
}

/** Everything known about each rated track; one artist's when given. */
export async function trackFacts(userId: string, scope: { artistId?: string; albumId?: string; genreId?: string } = {}): Promise<TrackFact[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.recording_id AS id, r.title, s.quality_score AS score, ax.rated_at, r.length_ms,
            g.id AS album_id, g.title AS album_title, g.type AS album_type,
            coalesce(g.first_release_date, r.first_release_date) AS released,
            t.position, (SELECT count(*) FROM track t2 WHERE t2.release_id = cn.release_id) AS size,
            (t.recording_id IS NOT NULL) AS on_album,
            (SELECT x.label FROM release x WHERE x.id = cn.release_id) AS label,
            (SELECT json_group_array(json_object('id', a.id, 'name', a.name, 'role', ac.role, 'label', cr.label, 'family', cr.family,
                                                 'position', ac.position, 'born', CASE WHEN a.kind = 'person' THEN a.begin_date END))
             FROM artist_credit ac JOIN artist a ON a.id = ac.artist_id JOIN credit_role cr ON cr.id = ac.role
             WHERE ac.entity_type = 'recording' AND ac.entity_id = r.id) AS credits,
            (SELECT json_group_array(DISTINCT json_object('id', gn.id, 'name', gn.name))
             FROM genre_tag gt JOIN genre gn ON gn.id = gt.genre_id
             WHERE (gt.entity_type = 'recording' AND gt.entity_id = r.id)
                OR (gt.entity_type = 'release_group' AND gt.entity_id = g.id)) AS genres,
            (SELECT count(*) FROM play p WHERE p.user_id = s.user_id AND p.recording_id = r.id) AS plays,
            ax.production, ax.songwriting, ax.lyrics, ax.performance, ax.gut_score
     FROM v_recording_score s
     JOIN recording r ON r.id = s.recording_id
     LEFT JOIN rating ax ON ax.user_id = s.user_id AND ax.entity_type = 'recording' AND ax.entity_id = r.id
          AND ax.rated_at = (SELECT max(y.rated_at) FROM rating y WHERE y.user_id = s.user_id AND y.entity_type = 'recording' AND y.entity_id = r.id)
     LEFT JOIN v_recording_album ra ON ra.recording_id = r.id
     LEFT JOIN release_group g ON g.id = ra.release_group_id
     LEFT JOIN v_release_group_canonical cn ON cn.release_group_id = g.id
     LEFT JOIN track t ON t.release_id = cn.release_id AND t.recording_id = r.id
     WHERE s.user_id = ?1
       AND (?2 IS NULL OR EXISTS (SELECT 1 FROM artist_credit pc WHERE pc.entity_type = 'recording' AND pc.entity_id = r.id
                                  AND pc.artist_id = ?2 AND pc.role IN ('primary', 'featured')))
       AND (?3 IS NULL OR EXISTS (SELECT 1 FROM track at JOIN release ar ON ar.id = at.release_id
                                  WHERE at.recording_id = r.id AND ar.release_group_id = ?3))
       -- A genre: tagged on the track, or on its album when the track has no genre of its own.
       AND (?4 IS NULL OR EXISTS (SELECT 1 FROM genre_tag gt4 WHERE gt4.genre_id = ?4
                                  AND ((gt4.entity_type = 'recording' AND gt4.entity_id = r.id)
                                    OR (gt4.entity_type = 'release_group' AND gt4.entity_id = g.id
                                        AND NOT EXISTS (SELECT 1 FROM genre_tag own WHERE own.entity_type = 'recording' AND own.entity_id = r.id)))))
     GROUP BY s.recording_id`,
  )
    .bind(userId, scope.artistId ?? null, scope.albumId ?? null, scope.genreId ?? null)
    .all<Row>();
  const parse = <T,>(json: string | null): T[] => {
    try {
      return (JSON.parse(json ?? '[]') as T[]).filter(Boolean);
    } catch {
      return [];
    }
  };
  return results.map((r) => ({
    id: r.id,
    title: r.title,
    score: r.score,
    ratedAt: r.rated_at,
    lengthMs: r.length_ms,
    albumId: r.album_id,
    albumTitle: r.album_title,
    albumType: r.album_type,
    released: r.released,
    position: r.on_album ? r.position : null,
    size: r.on_album ? r.size : null,
    extra: Boolean(r.album_id) && !r.on_album,
    label: r.label,
    credits: parse<Credit>(r.credits),
    genres: parse<{ id: string; name: string }>(r.genres),
    plays: r.plays ?? 0,
    axes: { production: r.production, songwriting: r.songwriting, lyrics: r.lyrics, performance: r.performance },
    // Only where the considered axes are there too: otherwise the score is the gut.
    gut: r.gut_score !== null && r.production !== null ? r.gut_score * 10 : null,
  }));
}

/**
 * The whole library's facts, cached in KV under a key that changes whenever
 * a rating, a play or the catalogue does, so it is never stale and the
 * home page doesn't gather every track's facts on every visit.
 */
export async function libraryFacts(userId: string): Promise<TrackFact[]> {
  return byLibrary('facts:v2', userId, () => trackFacts(userId));
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

export const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

export function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
}

export const sd = (xs: number[]) => Math.sqrt(variance(xs));

/** Pearson's r, or null when either side does not vary. */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

/**
 * How clearly a group differs from the rest: Welch's t. Each side's
 * variance has a floor, so three identical 100s don't read as certainty.
 */
export function separation(group: number[], rest: number[]): { diff: number; t: number } {
  const floor = 9;
  const diff = mean(group) - mean(rest);
  const se = Math.sqrt(Math.max(variance(group), floor) / group.length + Math.max(variance(rest), floor) / rest.length);
  return { diff, t: diff / se };
}

/** A correlation's t, so trends and group differences rank on one scale. */
export const correlationT = (r: number, n: number) => (Math.abs(r) >= 0.999 ? 10 : r * Math.sqrt((n - 2) / (1 - r * r)));

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export type Tone = 'up' | 'down' | 'neutral';

export interface Finding {
  /** Stable, so a page can link or remember one. */
  key: string;
  /** Kinds are spread across the results: never a page of producers only. */
  kind: string;
  headline: string;
  detail: string;
  strength: number;
  tracks: number;
  tone: Tone;
  href?: string;
}

const round = (x: number) => Math.round(x);
const points = (d: number) => `${Math.abs(round(d))} ${Math.abs(round(d)) === 1 ? 'point' : 'points'}`;
const tracksWord = (n: number) => `${n} ${n === 1 ? 'track' : 'tracks'}`;
const above = (d: number) => (d >= 0 ? 'above' : 'below');
const yearOf = (date: string | null) => (date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null);

/** What a credit means in a sentence: "produced", "wrote", "mixed". */
function verb(role: string, label: string): string {
  const verbs: Record<string, string> = {
    producer: 'produced',
    co_producer: 'co-produced',
    additional_producer: 'had a hand in producing',
    executive_producer: 'executive produced',
    vocal_producer: 'vocal produced',
    writer: 'wrote',
    composer: 'composed',
    lyricist: 'wrote the words to',
    mixer: 'mixed',
    mastering_engineer: 'mastered',
    recording_engineer: 'recorded',
    engineer: 'engineered',
    arranger: 'arranged',
    programming: 'programmed',
    remixer: 'remixed',
  };
  return verbs[role] ?? `played ${label.toLowerCase()} on`;
}

interface Group {
  kind: string;
  key: string;
  ids: Set<string>;
  scores: number[];
  /** Sentence pieces: the subject ("Tracks Pete Rango produced") and a link. */
  subject: string;
  href?: string;
}

interface Options {
  /** One artist's page: the artist is a given, so groups by artist are left out. */
  artistId?: string;
  /** One album's page: groups by album, label, year and type say nothing there. */
  albumId?: string;
  /** One genre's page: every track has the genre, so genre groups say nothing. */
  genreId?: string;
  /** Smallest group worth a sentence. */
  minGroup?: number;
  limit?: number;
}

/** Every group the facts form, keyed so the same group from two routes is counted once. */
function groupsOf(facts: TrackFact[], opts: Options): Group[] {
  const groups = new Map<string, Group>();
  const add = (kind: string, key: string, fact: TrackFact, subject: string, href?: string) => {
    const id = `${kind}:${key}`;
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { kind, key, ids: new Set(), scores: [], subject, href }));
    if (g.ids.has(fact.id)) return;
    g.ids.add(fact.id);
    g.scores.push(fact.score);
  };

  for (const f of facts) {
    const primary = f.credits.filter((c) => c.role === 'primary');
    for (const c of f.credits) {
      if (c.role === 'primary') {
        if (!opts.artistId) add('artist', c.id, f, `${c.name}’s tracks`, `/artist/${c.id}`);
      } else if (c.role === 'featured') {
        if (c.id !== opts.artistId) add('guest', c.id, f, `Tracks featuring ${c.name}`, `/artist/${c.id}`);
      } else if (c.family !== 'artist') {
        // Someone credited for their part: grouped by person and part.
        const self = primary.some((p) => p.id === c.id);
        const name = self && opts.artistId === c.id ? 'they' : c.name;
        add(`credit:${c.family}`, `${c.id}:${c.role}`, f, `Tracks ${name} ${verb(c.role, c.label)}`, `/artist/${c.id}/as/${c.role}`);
      }
    }
    for (const g of f.genres) if (g.id !== opts.genreId) add('genre', g.id, f, `Your ${g.name}`, `/genre/${g.id}`);
    // On one album's page these are the same for every track.
    const whole = !opts.albumId;
    if (whole && f.label) add('label', f.label.toLowerCase(), f, `Releases on ${f.label}`);
    const year = yearOf(f.released);
    if (whole && year) {
      if (opts.artistId) add('year', String(year), f, `Their ${year} tracks`);
      else add('decade', String(Math.floor(year / 10) * 10), f, `Music from the ${Math.floor(year / 10) * 10}s`);
    }
    if (opts.artistId && f.albumId) add('album', f.albumId, f, f.albumTitle ?? 'One album', `/album/${f.albumId}`);
    if (whole && f.albumType) {
      const type: Record<string, string> = { album: 'Album tracks', ep: 'EP tracks', single: 'Singles', mixtape: 'Mixtape tracks', live: 'Live recordings', compilation: 'Compilation tracks', soundtrack: 'Soundtrack songs' };
      add('type', f.albumType, f, type[f.albumType] ?? f.albumType);
    }
    if (f.extra) add('place', 'extra', f, 'Bonus tracks from deluxe editions');
    if (f.position && f.size && f.size >= 4) {
      if (f.position === 1) add('place', 'opener', f, 'Openers');
      else if (f.position === f.size) add('place', 'closer', f, 'Closers');
      else if (f.position === 2) add('place', 'second', f, 'Second tracks');
    }
    if (f.credits.some((c) => c.role === 'featured') || primary.length > 1) add('company', 'guest', f, 'Songs with a guest');
    if (f.lengthMs) {
      const m = f.lengthMs / 60000;
      const band = m < 2 ? 'under 2 minutes' : m < 3 ? '2 to 3 minutes' : m >= 6 ? 'over 6 minutes' : null;
      if (band) add('length', band, f, `Songs ${band}`);
    }
    const writers = new Set(f.credits.filter((c) => ['writer', 'composer', 'lyricist'].includes(c.role)).map((c) => c.id));
    if (writers.size >= 5) add('writers', 'many', f, 'Songs with five or more writers');
    else if (writers.size === 1) add('writers', 'one', f, 'Songs with a single writer');
    if (f.ratedAt) {
      const d = new Date(f.ratedAt);
      const day = d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'Europe/Dublin' });
      add('habit:day', day, f, `Tracks you rate on ${day}s`);
      const hour = Number(d.toLocaleString('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/Dublin' }));
      if (hour >= 23 || hour < 5) add('habit:hour', 'late', f, 'Tracks you rate after 11 at night');
      else if (hour < 11) add('habit:hour', 'morning', f, 'Tracks you rate in the morning');
    }
    if (f.plays >= 20) add('plays', 'many', f, 'Songs you’ve played 20 times or more');
    // How the title is written: a stylistic choice that may say something.
    const letters = f.title.replace(/[^\p{L}]/gu, '');
    if (letters.length >= 3 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) add('title', 'caps', f, 'Songs titled in capitals');
    else if (letters.length >= 3 && letters === letters.toLowerCase() && letters !== letters.toUpperCase()) add('title', 'lower', f, 'Songs titled all in lower case');
    const words = f.title.replace(/\(.*?\)|\[.*?\]/g, '').trim().split(/\s+/).filter(Boolean).length;
    if (words === 1) add('title', 'one-word', f, 'One-word titles');
    else if (words >= 5) add('title', 'long', f, 'Titles of five words or more');
  }
  return [...groups.values()];
}

/** How a group's tracks compare with all the others, as a finding when they clearly differ. */
function groupFindings(facts: TrackFact[], opts: Options): Finding[] {
  const min = opts.minGroup ?? (facts.length > 60 ? 4 : 3);
  const all = facts.map((f) => f.score);
  const out: Finding[] = [];
  const groups = groupsOf(facts, opts).filter((g) => g.scores.length >= min && facts.length - g.scores.length >= min);
  // A credit that covers the same tracks as an artist group says nothing new.
  const artistSets = groups.filter((g) => g.kind === 'artist').map((g) => g.ids);
  const same = (a: Set<string>, b: Set<string>) => {
    let shared = 0;
    for (const id of a) if (b.has(id)) shared++;
    return shared / Math.max(a.size, b.size) >= 0.9;
  };
  for (const g of groups) {
    if (g.kind.startsWith('credit:') && artistSets.some((s) => same(s, g.ids))) continue;
    const rest = facts.filter((f) => !g.ids.has(f.id)).map((f) => f.score);
    const { diff, t } = separation(g.scores, rest);
    if (Math.abs(diff) < 3 || Math.abs(t) < 2) continue;
    const m = mean(g.scores);
    out.push({
      key: `${g.kind}:${g.key}`,
      kind: g.kind.split(':')[0]!,
      headline: `${g.subject} average ${round(m)}, ${points(diff)} ${above(diff)} the rest`,
      detail: `${tracksWord(g.scores.length)}, against ${round(mean(rest))} for the other ${rest.length}.`,
      strength: Math.abs(t),
      tracks: g.scores.length,
      tone: diff > 0 ? 'up' : 'down',
      href: g.href,
    });
  }
  void all;
  return out;
}

interface Measure {
  key: string;
  value: (f: TrackFact) => number | null;
  rises: string;
  falls: string;
  min?: number;
}

/** Numbers that might move with the score. */
function measures(facts: TrackFact[], opts: Options): Measure[] {
  const order = new Map(
    facts
      .filter((f) => f.ratedAt)
      .sort((a, b) => a.ratedAt!.localeCompare(b.ratedAt!))
      .map((f, i) => [f.id, i]),
  );
  const leadAge = (f: TrackFact) => {
    const lead = f.credits.find((c) => c.role === 'primary' && c.position <= 1 && c.born);
    const year = yearOf(f.released);
    const born = yearOf(lead?.born ?? null);
    return year && born && year - born >= 10 && year - born <= 90 ? year - born : null;
  };
  return [
    { key: 'length', value: (f) => (f.lengthMs ? f.lengthMs / 60000 : null), rises: 'The longer the song, the higher you rate it', falls: 'The shorter the song, the higher you rate it' },
    {
      key: 'year',
      value: (f) => yearOf(f.released),
      rises: opts.artistId ? 'They’ve got better with time: newer tracks score higher' : 'You rate newer music higher',
      falls: opts.artistId ? 'Their early work is their best: older tracks score higher' : 'You rate older music higher',
    },
    { key: 'age', value: leadAge, rises: 'Artists score higher the older they were when they made it', falls: 'Artists score higher the younger they were when they made it' },
    {
      key: 'place',
      value: (f) => (f.position && f.size && f.size >= 4 ? (f.position - 1) / (f.size - 1) : null),
      rises: 'Albums get better as they go: later tracks score higher',
      falls: 'Albums front-load: earlier tracks score higher',
    },
    {
      key: 'credits',
      value: (f) => f.credits.filter((c) => c.family !== 'artist').length || null,
      rises: 'The more people credited on a song, the higher you rate it',
      falls: 'The fewer people credited on a song, the higher you rate it',
    },
    { key: 'plays', value: (f) => (f.plays ? Math.log1p(f.plays) : null), rises: 'What you play most, you rate highest', falls: 'You rate highest what you play least', min: 15 },
    {
      key: 'fresh',
      // Days from release to rating, on a log scale: a week and a month differ more than year nine and ten.
      value: (f) => {
        if (!f.ratedAt || !f.released || !/^\d{4}-\d{2}-\d{2}/.test(f.released)) return null;
        const days = (Date.parse(f.ratedAt) - Date.parse(f.released.slice(0, 10))) / 86_400_000;
        return days >= 0 ? Math.log1p(days) : null;
      },
      rises: 'The longer after release you get to something, the higher you rate it',
      falls: 'You rate music highest when you hear it new',
    },
    { key: 'size', value: (f) => f.size, rises: 'Longer albums get higher scores from you', falls: 'Shorter albums get higher scores from you' },
    {
      key: 'drift',
      value: (f) => order.get(f.id) ?? null,
      rises: opts.artistId ? 'You’ve warmed to them: later ratings run higher' : 'You’ve got more generous: recent ratings run higher',
      falls: opts.artistId ? 'You’ve cooled on them: later ratings run lower' : 'You’ve got stricter: recent ratings run lower',
      min: 20,
    },
  ];
}

function trendFindings(facts: TrackFact[], opts: Options): Finding[] {
  const out: Finding[] = [];
  for (const m of measures(facts, opts)) {
    const pairs = facts.map((f) => [m.value(f), f.score] as const).filter((p): p is readonly [number, number] => p[0] !== null);
    if (pairs.length < (m.min ?? 12)) continue;
    const r = pearson(
      pairs.map((p) => p[0]),
      pairs.map((p) => p[1]),
    );
    if (r === null || Math.abs(r) < 0.2) continue;
    const t = correlationT(r, pairs.length);
    if (Math.abs(t) < 2) continue;
    out.push({
      key: `trend:${m.key}`,
      kind: 'trend',
      headline: r > 0 ? m.rises : m.falls,
      detail: `${Math.abs(r) >= 0.5 ? 'A strong' : Math.abs(r) >= 0.3 ? 'A clear' : 'A slight'} pattern across ${tracksWord(pairs.length)} (r = ${r.toFixed(2)}).`,
      strength: Math.abs(t),
      tracks: pairs.length,
      tone: 'neutral',
    });
  }
  return out;
}

/** Which axis decides a score, and which one you are hardest on. */
function axisFindings(facts: TrackFact[]): Finding[] {
  const names = ['production', 'songwriting', 'lyrics', 'performance'] as const;
  const detailed = facts.filter((f) => names.every((n) => f.axes[n] !== null));
  if (detailed.length < 8) return [];
  const out: Finding[] = [];
  // The axis that moves most with the others' total: the one that decides.
  const decides = names
    .map((n) => {
      const others = detailed.map((f) => names.filter((o) => o !== n).reduce((a, o) => a + f.axes[o]!, 0));
      return { n, r: pearson(detailed.map((f) => f.axes[n]!), others) ?? 0, avg: mean(detailed.map((f) => f.axes[n]! * 10)) };
    })
    .sort((a, b) => a.r - b.r);
  const loner = decides[0]!;
  if (loner.r < 0.4) {
    out.push({
      key: 'axes:independent',
      kind: 'axes',
      headline: `${loner.n[0]!.toUpperCase()}${loner.n.slice(1)} is its own thing for you`,
      detail: `It barely moves with your other three axes (r = ${loner.r.toFixed(2)}): a song can be great or poor on ${loner.n} whatever else it does.`,
      strength: 2 + (0.4 - loner.r) * 5,
      tracks: detailed.length,
      tone: 'neutral',
    });
  }
  const byAvg = [...decides].sort((a, b) => a.avg - b.avg);
  const low = byAvg[0]!;
  const high = byAvg.at(-1)!;
  if (high.avg - low.avg >= 4) {
    const gaps = detailed.map((f) => (f.axes[high.n]! - f.axes[low.n]!) * 10);
    const t = mean(gaps) / (Math.max(sd(gaps), 3) / Math.sqrt(gaps.length));
    out.push({
      key: 'axes:gap',
      kind: 'axes',
      headline: `You’re hardest on ${low.n}`,
      detail: `${low.n[0]!.toUpperCase()}${low.n.slice(1)} averages ${round(low.avg)}, ${points(high.avg - low.avg)} under ${high.n} at ${round(high.avg)}, across ${tracksWord(detailed.length)}.`,
      strength: Math.abs(t),
      tracks: detailed.length,
      tone: 'neutral',
    });
  }
  return out;
}

/**
 * Where the first instinct and the considered rating part ways: groups
 * whose gut scores run further above (or below) the considered score than
 * usual. The usual gap is calibration and already allowed for; this finds
 * who or what it is biased about.
 */
function gutFindings(facts: TrackFact[], opts: Options): Finding[] {
  const both = facts.filter((f) => f.gut !== null);
  if (both.length < 10) return [];
  const gap = new Map(both.map((f) => [f.id, f.gut! - f.score]));
  const out: Finding[] = [];
  for (const g of groupsOf(both, opts)) {
    if (!['artist', 'genre', 'credit:production', 'decade', 'type'].includes(g.kind) || g.ids.size < 4 || both.length - g.ids.size < 4) continue;
    const inside = [...g.ids].map((id) => gap.get(id)!);
    const outside = both.filter((f) => !g.ids.has(f.id)).map((f) => gap.get(f.id)!);
    const { diff, t } = separation(inside, outside);
    if (Math.abs(diff) < 4 || Math.abs(t) < 2) continue;
    out.push({
      key: `gut:${g.kind}:${g.key}`,
      kind: 'gut',
      headline: `Your gut ${diff > 0 ? 'overrates' : 'underrates'} ${g.subject.replace(/^Tracks |^Your /, '').replace(/’s tracks$/, '')}`,
      detail: `First instincts run ${points(diff)} ${diff > 0 ? 'higher' : 'lower'} than your considered scores there, compared with everything else (${tracksWord(inside.length)}).`,
      strength: Math.abs(t),
      tracks: inside.length,
      tone: 'neutral',
      href: g.href,
    });
  }
  return out;
}

/** The track that doesn't fit its album: far below or above the rest of it. */
function oddOnes(facts: TrackFact[]): Finding[] {
  const byAlbum = new Map<string, TrackFact[]>();
  for (const f of facts) if (f.albumId && !f.extra) byAlbum.set(f.albumId, [...(byAlbum.get(f.albumId) ?? []), f]);
  const out: Finding[] = [];
  for (const tracks of byAlbum.values()) {
    if (tracks.length < 5) continue;
    for (const f of tracks) {
      const rest = tracks.filter((x) => x !== f).map((x) => x.score);
      const diff = f.score - mean(rest);
      const spread = Math.max(sd(rest), 3);
      const z = diff / spread;
      if (Math.abs(diff) < 10 || Math.abs(z) < 2.5) continue;
      out.push({
        key: `odd:${f.id}`,
        kind: 'odd',
        headline:
          diff < 0
            ? `“${f.title}” is the one you’d skip on ${f.albumTitle}`
            : `“${f.title}” towers over the rest of ${f.albumTitle}`,
        detail: `${round(f.score)}, against ${round(mean(rest))} for the other ${rest.length} tracks.`,
        strength: Math.min(Math.abs(z), 6),
        tracks: tracks.length,
        tone: diff > 0 ? 'up' : 'down',
        href: `/track/${f.id}`,
      });
    }
  }
  return out;
}

/** Library-wide only: who never misses, and who splits you. */
function consistency(facts: TrackFact[]): Finding[] {
  const byArtist = new Map<string, { name: string; scores: number[] }>();
  for (const f of facts)
    for (const c of f.credits.filter((x) => x.role === 'primary')) {
      const a = byArtist.get(c.id) ?? { name: c.name, scores: [] };
      a.scores.push(f.score);
      byArtist.set(c.id, a);
    }
  const ranked = [...byArtist.entries()].filter(([, a]) => a.scores.length >= 6).map(([id, a]) => ({ id, ...a, spread: sd(a.scores) }));
  if (ranked.length < 3) return [];
  ranked.sort((a, b) => a.spread - b.spread);
  const steady = ranked[0]!;
  const split = ranked.at(-1)!;
  const typical = mean(ranked.map((r) => r.spread));
  const out: Finding[] = [];
  if (steady.spread < typical * 0.6) {
    const lo = Math.min(...steady.scores);
    out.push({
      key: `steady:${steady.id}`,
      kind: 'consistency',
      headline: `${steady.name} never misses`,
      detail: `Across ${tracksWord(steady.scores.length)} nothing scores below ${round(lo)}; the most even of anyone you’ve rated.`,
      strength: 2 + (typical / Math.max(steady.spread, 1)) * 0.5,
      tracks: steady.scores.length,
      tone: 'up',
      href: `/artist/${steady.id}`,
    });
  }
  if (split.spread > typical * 1.5) {
    out.push({
      key: `split:${split.id}`,
      kind: 'consistency',
      headline: `${split.name} splits you`,
      detail: `From ${round(Math.min(...split.scores))} to ${round(Math.max(...split.scores))} across ${tracksWord(split.scores.length)}: the widest spread of anyone you’ve rated.`,
      strength: 2 + (split.spread / Math.max(typical, 1)) * 0.5,
      tracks: split.scores.length,
      tone: 'neutral',
      href: `/artist/${split.id}`,
    });
  }
  return out;
}

/**
 * The strongest findings, at most two of a kind until the others run out,
 * so a library heavy on one producer still gets a varied page.
 */
export function discover(facts: TrackFact[], opts: Options = {}): Finding[] {
  if (facts.length < 6) return [];
  const all = [
    ...groupFindings(facts, opts),
    ...trendFindings(facts, opts),
    ...axisFindings(facts),
    ...gutFindings(facts, opts),
    ...oddOnes(facts),
    ...(opts.artistId ? [] : consistency(facts)),
  ].sort((a, b) => b.strength - a.strength);
  const limit = opts.limit ?? 12;
  const picked: Finding[] = [];
  const perKind = new Map<string, number>();
  for (const f of all) {
    if (picked.length >= limit) break;
    if ((perKind.get(f.kind) ?? 0) >= 2) continue;
    picked.push(f);
    perKind.set(f.kind, (perKind.get(f.kind) ?? 0) + 1);
  }
  for (const f of all) {
    if (picked.length >= limit) break;
    if (!picked.includes(f)) picked.push(f);
  }
  return picked;
}

// ---------------------------------------------------------------------------
// One artist, at a glance
// ---------------------------------------------------------------------------

export interface ArtistBreakdown {
  rated: number;
  average: number;
  median: number;
  /** The top and bottom tracks, and how many others share each score. */
  best: { id: string; title: string; score: number; level: number };
  worst: { id: string; title: string; score: number; level: number };
  /** Standard deviation of their track scores, and how that compares. */
  spread: number;
  steadiness: 'steady' | 'typical' | 'uneven';
  /** Their average against the whole library's. */
  versusLibrary: number;
  /** Among artists with at least three rated tracks: 1 is the best. */
  rank: { position: number; of: number } | null;
  albums: { id: string; title: string; average: number; tracks: number }[];
  findings: Finding[];
}

/** The whole library's average, artists ranked by average, and how spread an artist's scores usually are. */
async function libraryRanks(userId: string): Promise<{ libraryAverage: number; ranking: { artist_id: string; average: number; n: number }[]; typicalSpread: number }> {
  const [library, ranks] = await env.DB.batch([
    env.DB.prepare('SELECT avg(quality_score) AS average, count(*) AS n FROM v_recording_score WHERE user_id = ?').bind(userId),
    env.DB.prepare(
      `SELECT c.artist_id, avg(s.quality_score) AS average, count(*) AS n
       FROM v_recording_score s JOIN artist_credit c ON c.entity_type = 'recording' AND c.entity_id = s.recording_id AND c.role = 'primary'
       WHERE s.user_id = ? GROUP BY c.artist_id HAVING count(*) >= 3 ORDER BY average DESC`,
    ).bind(userId),
  ]);
  const libraryAverage = (library!.results[0] as { average: number } | undefined)?.average ?? 0;
  const ranking = ranks!.results as { artist_id: string; average: number; n: number }[];
  const spreads = await env.DB.prepare(
    `SELECT c.artist_id, s.quality_score AS score
     FROM v_recording_score s JOIN artist_credit c ON c.entity_type = 'recording' AND c.entity_id = s.recording_id AND c.role = 'primary'
     WHERE s.user_id = ?`,
  )
    .bind(userId)
    .all<{ artist_id: string; score: number }>();
  const perArtist = new Map<string, number[]>();
  for (const r of spreads.results) perArtist.set(r.artist_id, [...(perArtist.get(r.artist_id) ?? []), r.score]);
  const typicalSpread = mean([...perArtist.values()].filter((s) => s.length >= 4).map(sd));
  return { libraryAverage, ranking, typicalSpread };
}

export async function artistBreakdown(userId: string, artistId: string): Promise<ArtistBreakdown | null> {
  const facts = await trackFacts(userId, { artistId });
  if (facts.length < 3) return null;
  const { libraryAverage, ranking, typicalSpread } = await byLibrary('artist-ranks:v1', userId, () => libraryRanks(userId));

  const scores = facts.map((f) => f.score);
  const sorted = [...facts].sort((a, b) => b.score - a.score);
  const ordered = [...scores].sort((a, b) => a - b);
  const median = ordered.length % 2 ? ordered[(ordered.length - 1) / 2]! : (ordered[ordered.length / 2 - 1]! + ordered[ordered.length / 2]!) / 2;
  const spread = sd(scores);
  const position = ranking.findIndex((r) => r.artist_id === artistId);

  const albums = new Map<string, { id: string; title: string; scores: number[] }>();
  for (const f of facts)
    if (f.albumId) {
      const a = albums.get(f.albumId) ?? { id: f.albumId, title: f.albumTitle ?? '', scores: [] };
      a.scores.push(f.score);
      albums.set(f.albumId, a);
    }

  return {
    rated: facts.length,
    average: mean(scores),
    median,
    best: { id: sorted[0]!.id, title: sorted[0]!.title, score: sorted[0]!.score, level: scores.filter((s) => s === sorted[0]!.score).length - 1 },
    worst: { id: sorted.at(-1)!.id, title: sorted.at(-1)!.title, score: sorted.at(-1)!.score, level: scores.filter((s) => s === sorted.at(-1)!.score).length - 1 },
    spread,
    steadiness: !typicalSpread ? 'typical' : spread < typicalSpread * 0.7 ? 'steady' : spread > typicalSpread * 1.3 ? 'uneven' : 'typical',
    versusLibrary: mean(scores) - libraryAverage,
    rank: position >= 0 ? { position: position + 1, of: ranking.length } : null,
    albums: [...albums.values()]
      .filter((a) => a.scores.length >= 2)
      .map((a) => ({ id: a.id, title: a.title, average: mean(a.scores), tracks: a.scores.length }))
      .sort((a, b) => b.average - a.average),
    findings: discover(facts, { artistId, limit: 6, minGroup: 3 }),
  };
}
