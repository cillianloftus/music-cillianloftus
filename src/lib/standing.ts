/**
 * Where one track stands: on its album, in its artist's work, in its year,
 * across everything rated, and on each axis. Only what is notable is said
 * (a top three, a top tenth, a record), so a middling track gets a line or
 * none rather than a list of unremarkable ranks.
 */

import { env } from 'cloudflare:workers';
import type { TrackFact } from './discover';
import { byLibrary } from './library-cache';

export interface Standing {
  text: string;
  href?: string;
}

const ordinal = (n: number) => {
  const rem = n % 100;
  const suffix = rem >= 11 && rem <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
};

const AXES = ['arrangement', 'sound', 'songwriting', 'lyrics', 'performance', 'originality'] as const;

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

export interface AlbumScore {
  id: string;
  score: number;
  type: string;
  year: string | null;
  artists: string[];
  artistNames: string[];
}

/** Every scored release for a user, cached by library state. */
export async function albumScores(userId: string): Promise<AlbumScore[]> {
  return byLibrary('album-scores:v1', userId, async () => {
    const { results } = await env.DB.prepare(
      `SELECT s.release_group_id AS id, s.quality_score AS score, g.type, substr(g.first_release_date, 1, 4) AS year,
              (SELECT json_group_array(c.artist_id) FROM artist_credit c WHERE c.entity_type = 'release_group' AND c.entity_id = g.id AND c.role = 'primary') AS artists,
              (SELECT json_group_array(a.name) FROM artist_credit c JOIN artist a ON a.id = c.artist_id
               WHERE c.entity_type = 'release_group' AND c.entity_id = g.id AND c.role = 'primary') AS names
       FROM v_release_score s JOIN release_group g ON g.id = s.release_group_id
       WHERE s.user_id = ? AND s.quality_score IS NOT NULL`,
    )
      .bind(userId)
      .all<{ id: string; score: number; type: string; year: string | null; artists: string; names: string }>();
    return results.map((r) => ({ ...r, artists: JSON.parse(r.artists) as string[], artistNames: JSON.parse(r.names) as string[] }));
  });
}

/** Where an album stands: among everything, its artist's releases, its year. */
export function albumStanding(albums: AlbumScore[], id: string): Standing[] {
  const me = albums.find((a) => a.id === id);
  if (!me) return [];
  const out: Standing[] = [];
  const kind = me.type === 'ep' ? 'EP' : me.type === 'single' ? 'single' : me.type === 'mixtape' ? 'mixtape' : 'album';
  // Like for like: albums and mixtapes together, EPs, singles.
  const sameKind = albums.filter((a) => (['album', 'mixtape'].includes(me.type) ? ['album', 'mixtape'].includes(a.type) : a.type === me.type));

  if (sameKind.length >= 5) {
    const { above, level } = placing(me.score, sameKind.map((a) => a.score));
    const words = rankWords(above, level, 5);
    if (words) out.push({ text: `Your ${words} ${kind}, of ${sameKind.length}` });
  }
  me.artists.forEach((artistId, i) => {
    if (i > 1) return;
    const theirs = sameKind.filter((a) => a.artists.includes(artistId));
    if (theirs.length < 3) return;
    const { above, level } = placing(me.score, theirs.map((a) => a.score));
    const words = rankWords(above, level, 2);
    if (words) out.push({ text: `Your ${words} ${me.artistNames[i]} ${kind}, of ${theirs.length}`, href: `/artist/${artistId}` });
    else if (above === theirs.length - 1 && level === 0) out.push({ text: `Your least favourite ${me.artistNames[i]} ${kind}`, href: `/artist/${artistId}` });
  });
  if (me.year) {
    const sameYear = sameKind.filter((a) => a.year === me.year);
    if (sameYear.length >= 3) {
      const { above, level } = placing(me.score, sameYear.map((a) => a.score));
      if (above === 0 && level === 0) out.push({ text: `Your favourite ${kind} of ${me.year}`, href: `/year/${me.year}` });
    }
  }
  return out.slice(0, 3);
}
