/**
 * The review queue in the order worth working through: items about music
 * Cillian has rated come first, then items by the artists he has rated
 * most, so a few thousand open pairs start with the ones he cares about.
 * It can be narrowed to one artist (the pills) or by a search over titles
 * and artists.
 *
 * Which artist and title each item is about is kept until new items are
 * raised (byStamp on the anomaly rowids: building it reads ~20,000 rows
 * for 3,000 items); how much each artist matters moves with the ratings
 * (byScores). A page then reads only the open items of one kind.
 */

import { env } from 'cloudflare:workers';
import { byScores, byStamp } from './library-cache';
import type { Anomaly, AnomalyKind } from './review';
import { normaliseName } from './text';

/** Per item: its title and its artists, [id, name]. */
type Index = Record<string, { t: string; a: [string, string][] }>;

async function reviewIndex(kind: AnomalyKind): Promise<Index> {
  const stamp = String((await env.DB.prepare(`SELECT max(rowid) AS n FROM anomaly`).first<number>('n')) ?? 0);
  return byStamp(`review-index:v1:${kind}`, stamp, async () => {
    const { results } = await env.DB.prepare(
      `SELECT a.id,
              CASE a.entity_type
                WHEN 'artist' THEN (SELECT name FROM artist WHERE id = a.entity_a)
                WHEN 'recording' THEN (SELECT title FROM recording WHERE id = a.entity_a)
                ELSE (SELECT title FROM release_group WHERE id = a.entity_a) END AS t,
              CASE a.entity_type
                WHEN 'artist' THEN (SELECT json_group_array(json_array(id, name)) FROM artist WHERE id = a.entity_a)
                ELSE (SELECT json_group_array(json_array(ar.id, ar.name)) FROM artist_credit c JOIN artist ar ON ar.id = c.artist_id
                      WHERE c.entity_type = a.entity_type AND c.entity_id = a.entity_a AND c.role = 'primary') END AS a
       FROM anomaly a WHERE a.status = 'open' AND a.kind = ?`,
    )
      .bind(kind)
      .all<{ id: string; t: string | null; a: string | null }>();
    const index: Index = {};
    for (const r of results) {
      let artists: [string, string][] = [];
      try {
        artists = (JSON.parse(r.a ?? '[]') as [string, string][]).filter((x) => x && x[0]);
      } catch {
        /* None known. */
      }
      index[r.id] = { t: r.t ?? '', a: artists };
    }
    return index;
  });
}

/** How much each artist matters (songs and albums rated), and what is rated. */
async function care(userId: string | null): Promise<{ artists: Record<string, number>; rated: string[] }> {
  if (!userId) return { artists: {}, rated: [] };
  return byScores('review-care:v1', userId, async () => {
    const [byArtist, rated] = await env.DB.batch([
      env.DB.prepare(
        `SELECT c.artist_id AS id, count(DISTINCT r.entity_id) AS n
         FROM rating r JOIN artist_credit c ON c.entity_type = r.entity_type AND c.entity_id = r.entity_id AND c.role = 'primary'
         WHERE r.user_id = ? GROUP BY c.artist_id`,
      ).bind(userId),
      env.DB.prepare(`SELECT DISTINCT entity_id AS id FROM rating WHERE user_id = ?`).bind(userId),
    ]);
    return {
      artists: Object.fromEntries((byArtist!.results as { id: string; n: number }[]).map((r) => [r.id, r.n])),
      rated: (rated!.results as { id: string }[]).map((r) => r.id),
    };
  });
}

export interface ReviewFilter {
  /** One artist's items only. */
  artist?: string | null;
  /** Words in the title or an artist's name. */
  q?: string | null;
}

export interface ArtistPill {
  id: string;
  name: string;
  /** Open items of this kind about them (within the search). */
  count: number;
}

export interface ReviewQueue {
  items: Anomaly[];
  /** How many match the filter, all pages. */
  matched: number;
  pills: ArtistPill[];
  /** The artist filtered on, by name, when there is one. */
  artistName: string | null;
}

const PILLS = 14;

export async function reviewQueue(kind: AnomalyKind, userId: string | null, filter: ReviewFilter, limit: number): Promise<ReviewQueue> {
  const [index, cares, open] = await Promise.all([
    reviewIndex(kind),
    care(userId),
    env.DB.prepare(
      `SELECT id, kind, entity_type, entity_a, entity_b, detected_at, status, resolution, skipped_at
       FROM anomaly WHERE status = 'open' AND kind = ?`,
    )
      .bind(kind)
      .all<Anomaly>(),
  ]);
  return arrange(open.results, index, cares, filter, limit);
}

/** The sorting and narrowing, apart from the database: tested on its own. */
export function arrange(
  open: Anomaly[],
  index: Index,
  cares: { artists: Record<string, number>; rated: string[] },
  filter: ReviewFilter,
  limit: number,
): ReviewQueue {
  const rated = new Set(cares.rated);
  const words = filter.q ? normaliseName(filter.q).split(/\s+/).filter(Boolean) : [];
  const info = (a: Anomaly) => index[a.id] ?? { t: '', a: [] };
  const searched = open.filter((a) => {
    if (words.length === 0) return true;
    const { t, a: artists } = info(a);
    const text = normaliseName([t, ...artists.map(([, name]) => name)].join(' '));
    return words.every((w) => text.includes(w));
  });

  // The pills: the artists most worth working through among what matches the search.
  const tally = new Map<string, ArtistPill & { care: number }>();
  for (const a of searched) {
    for (const [id, name] of info(a).a) {
      const pill = tally.get(id) ?? { id, name, count: 0, care: cares.artists[id] ?? 0 };
      pill.count++;
      tally.set(id, pill);
    }
  }
  const ranked = [...tally.values()].sort((x, y) => y.care - x.care || y.count - x.count || x.name.localeCompare(y.name));
  let pills = ranked.slice(0, PILLS);
  const chosen = filter.artist ? tally.get(filter.artist) : undefined;
  if (chosen && !pills.includes(chosen)) pills = [chosen, ...pills.slice(0, PILLS - 1)];

  const matching = filter.artist ? searched.filter((a) => info(a).a.some(([id]) => id === filter.artist)) : searched;
  const worth = (a: Anomaly) =>
    (rated.has(a.entity_a) || (a.entity_b !== null && rated.has(a.entity_b)) ? 1_000_000 : 0) +
    Math.max(0, ...info(a).a.map(([id]) => cares.artists[id] ?? 0));
  const scored = matching.map((a) => ({ a, worth: worth(a) }));
  scored.sort(
    (x, y) =>
      // Skipped ones last, longest-skipped first among them, as before.
      Number(Boolean(x.a.skipped_at)) - Number(Boolean(y.a.skipped_at)) ||
      (x.a.skipped_at ?? '').localeCompare(y.a.skipped_at ?? '') ||
      y.worth - x.worth ||
      x.a.detected_at.localeCompare(y.a.detected_at) ||
      x.a.id.localeCompare(y.a.id),
  );
  return {
    items: scored.slice(0, limit).map((s) => s.a),
    matched: matching.length,
    pills: pills.map(({ id, name, count }) => ({ id, name, count })),
    artistName: chosen?.name ?? null,
  };
}
