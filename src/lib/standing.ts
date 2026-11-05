/**
 * Where one track stands: on its album, in its artist's work, in its year,
 * across everything rated, and on each axis. Only what is notable is said
 * (a top three, a top tenth, a record), so a middling track gets a line or
 * none rather than a list of unremarkable ranks.
 */

import type { TrackFact } from './discover';

export interface Standing {
  text: string;
  href?: string;
}

const ordinal = (n: number) => {
  const rem = n % 100;
  const suffix = rem >= 11 && rem <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
};

const AXES = ['production', 'songwriting', 'lyrics', 'performance'] as const;

/** How a track places among some scores: better than it, and level with it (itself excluded). */
function placing(score: number, scores: number[]): { above: number; level: number } {
  return { above: scores.filter((s) => s > score + 1e-9).length, level: scores.filter((s) => Math.abs(s - score) <= 1e-9).length - 1 };
}

/**
 * "favourite", "2nd favourite", "joint favourite (with 2 others)", or
 * nothing when it shares the place with too many to mean anything.
 */
function rankWords(above: number, level: number, top = 3): string | null {
  if (above >= top) return null;
  if (level === 0) return above === 0 ? 'favourite' : `${ordinal(above + 1)} favourite`;
  if (above === 0 && level <= 2) return `joint favourite (with ${level} ${level === 1 ? 'other' : 'others'})`;
  return null;
}

export function standing(facts: TrackFact[], id: string): Standing[] {
  const me = facts.find((f) => f.id === id);
  if (!me) return [];
  const out: Standing[] = [];

  // On its album.
  if (me.albumId) {
    const album = facts.filter((f) => f.albumId === me.albumId);
    if (album.length >= 3) {
      const { above, level } = placing(me.score, album.map((f) => f.score));
      const words = rankWords(above, level, 2);
      if (words) out.push({ text: `Your ${words} of ${album.length} rated on ${me.albumTitle}`, href: `/album/${me.albumId}` });
      else if (above === album.length - 1 && level === 0) out.push({ text: `Your lowest-rated on ${me.albumTitle}`, href: `/album/${me.albumId}` });
    }
  }

  // In each lead artist's work.
  for (const artist of me.credits.filter((c) => c.role === 'primary').slice(0, 2)) {
    const theirs = facts.filter((f) => f.credits.some((c) => c.role === 'primary' && c.id === artist.id));
    if (theirs.length < 5) continue;
    const { above, level } = placing(me.score, theirs.map((f) => f.score));
    const words = rankWords(above, level);
    if (words) out.push({ text: `Your ${words} ${artist.name} track, of ${theirs.length}`, href: `/artist/${artist.id}` });
  }

  // Across everything: ties count against it, so "top 5%" is always true.
  const all = facts.map((f) => f.score);
  if (all.length >= 30) {
    const { above, level } = placing(me.score, all);
    const percent = Math.ceil(((above + level + 1) / all.length) * 100);
    if (percent <= 10) out.push({ text: `In the top ${percent}% of the ${all.length.toLocaleString('en-GB')} tracks you’ve rated` });
  }

  // In its year.
  const year = me.released?.slice(0, 4);
  if (year && /^\d{4}$/.test(year)) {
    const sameYear = facts.filter((f) => f.released?.startsWith(year));
    if (sameYear.length >= 5) {
      const { above, level } = placing(me.score, sameYear.map((f) => f.score));
      if (above === 0 && level === 0) out.push({ text: `Your favourite from ${year}`, href: `/year/${year}` });
    }
  }

  // A record on an axis, unless half the library shares it.
  for (const axis of AXES) {
    const mine = me.axes[axis];
    if (mine === null) continue;
    const given = facts.map((f) => f.axes[axis]).filter((v): v is number => v !== null);
    if (given.length < 10 || mine < Math.max(...given)) continue;
    const others = given.filter((v) => v === mine).length - 1;
    if (others === 0) out.push({ text: `The highest ${axis} score you’ve given anything` });
    else if (others <= 2) out.push({ text: `Joint highest ${axis} score you’ve given (with ${others} ${others === 1 ? 'other' : 'others'})` });
  }

  // Gut against considered, when they part by a fair way.
  if (me.gut !== null && Math.abs(me.gut - me.score) >= 8) {
    out.push({ text: `Your gut said ${Math.round(me.gut)}; thinking it through made it ${Math.round(me.score)}` });
  }
  return out.slice(0, 4);
}
