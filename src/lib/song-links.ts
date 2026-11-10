/**
 * Samples and interpolations around one track (migration 0053): what it
 * takes from, and what takes from it. A song in the library leads to its
 * track page; any other, to its page on Genius.
 */

import { env } from 'cloudflare:workers';

export interface LinkedTrack {
  title: string;
  artist: string;
  year: number | null;
  /** Its Genius page. */
  url: string;
  /** The library's track for it, when there is one. */
  recording_id: string | null;
}

export interface TrackLinks {
  samples: LinkedTrack[];
  interpolates: LinkedTrack[];
  sampledIn: LinkedTrack[];
  interpolatedIn: LinkedTrack[];
}

type Row = LinkedTrack & { kind: 'samples' | 'interpolates'; uses: 0 | 1 };

export async function trackLinks(recordingId: string): Promise<TrackLinks> {
  const { results } = await env.DB.prepare(
    `WITH me AS (SELECT genius_url AS url FROM recording WHERE id = ?1 AND genius_url IS NOT NULL),
     linked AS (
       SELECT 1 AS uses, l.kind, l.source_url AS url, l.source_title AS title, l.source_artist AS artist, l.source_year AS year
       FROM me JOIN song_link l ON l.song_url = me.url
       UNION ALL
       SELECT 0, l.kind, l.song_url, l.song_title, l.song_artist, l.song_year
       FROM me JOIN song_link l ON l.source_url = me.url
     )
     SELECT k.*, (SELECT min(r.id) FROM recording r WHERE r.genius_url = k.url) AS recording_id
     FROM linked k`,
  )
    .bind(recordingId)
    .all<Row>();
  // Songs in the library first; then what it took from oldest first, and what took from it newest first.
  const of = (kind: Row['kind'], uses: 0 | 1) =>
    results
      .filter((r) => r.kind === kind && r.uses === uses)
      .sort(
        (a, b) =>
          Number(b.recording_id !== null) - Number(a.recording_id !== null) ||
          Number(a.year === null) - Number(b.year === null) ||
          (uses ? 1 : -1) * ((a.year ?? 0) - (b.year ?? 0)),
      )
      .map(({ kind: _k, uses: _u, ...track }) => track);
  return { samples: of('samples', 1), interpolates: of('interpolates', 1), sampledIn: of('samples', 0), interpolatedIn: of('interpolates', 0) };
}

/** An artist on the other side of an artist's samples, with how many songs each way. */
export interface SampledArtist {
  name: string;
  /** Their artist page here, when the library has an artist of that name. */
  id: string | null;
  /** One of their songs on Genius, for those the library does not have. */
  url: string;
  samples: number;
  interpolations: number;
}

export interface ArtistSampling {
  /** Whom their songs take from. */
  takesFrom: SampledArtist[];
  /** Who takes from their songs. */
  takenBy: SampledArtist[];
}

type SamplingRow = { takes: 0 | 1; kind: 'samples' | 'interpolates'; name: string; url: string; n: number };

/**
 * Whom an artist samples and interpolates, and who samples them, by artist
 * and most songs first, from the links of their own tracks (lead or
 * featured). Themselves left out. One seek of the credits, then of the
 * links each way, by index: a few hundred rows for a big artist.
 */
export async function artistSampling(artistId: string, limit = 12): Promise<ArtistSampling> {
  const { results } = await env.DB.prepare(
    `WITH mine AS (
       SELECT DISTINCT r.genius_url AS url
       FROM artist_credit c JOIN recording r ON r.id = c.entity_id
       WHERE c.entity_type = 'recording' AND c.artist_id = ?1 AND c.role IN ('primary', 'featured') AND r.genius_url IS NOT NULL
     ),
     linked AS (
       SELECT 1 AS takes, l.kind, l.source_artist AS name, min(l.source_url) AS url, count(DISTINCT l.source_url) AS n
       FROM mine JOIN song_link l ON l.song_url = mine.url
       GROUP BY l.kind, l.source_artist
       UNION ALL
       SELECT 0, l.kind, l.song_artist, min(l.song_url), count(DISTINCT l.song_url)
       FROM mine JOIN song_link l ON l.source_url = mine.url
       GROUP BY l.kind, l.song_artist
     )
     SELECT k.* FROM linked k
     WHERE k.name <> (SELECT name FROM artist WHERE id = ?1) COLLATE NOCASE`,
  )
    .bind(artistId)
    .all<SamplingRow>();
  // A few times as many as are shown are matched to the library, so that
  // artists here come first; matching every name read 11,000 rows for an
  // artist sampled by 700 others.
  const takesFrom = bySongs(results.filter((r) => r.takes === 1), limit * 4);
  const takenBy = bySongs(results.filter((r) => r.takes === 0), limit * 4);
  const shown = [...takesFrom, ...takenBy];
  if (shown.length) {
    const { results: found } = await env.DB.prepare(
      `SELECT j.value AS name, (SELECT a.id FROM artist a WHERE a.name = j.value COLLATE NOCASE ORDER BY a.id LIMIT 1) AS id
       FROM json_each(?1) j`,
    )
      .bind(JSON.stringify([...new Set(shown.map((a) => a.name))]))
      .all<{ name: string; id: string | null }>();
    const ids = new Map(found.map((f) => [f.name, f.id]));
    for (const a of shown) a.id = ids.get(a.name) ?? null;
  }
  // Stable: within each, still most songs first.
  const hereFirst = (list: SampledArtist[]) => [...list].sort((a, b) => Number(b.id !== null) - Number(a.id !== null)).slice(0, limit);
  return { takesFrom: hereFirst(takesFrom), takenBy: hereFirst(takenBy) };
}

/** One entry per artist, both kinds together, most songs first. Pure. */
export function bySongs(rows: SamplingRow[], limit: number): SampledArtist[] {
  const by = new Map<string, SampledArtist>();
  for (const r of rows) {
    // Genius's placeholder for an account since removed.
    if (r.name === 'Deleted Artist') continue;
    const key = r.name.toLowerCase();
    const one = by.get(key) ?? { name: r.name, id: null, url: r.url, samples: 0, interpolations: 0 };
    if (r.kind === 'samples') one.samples += r.n;
    else one.interpolations += r.n;
    by.set(key, one);
  }
  return [...by.values()]
    .sort((a, b) => b.samples + b.interpolations - (a.samples + a.interpolations) || a.name.localeCompare(b.name))
    .slice(0, limit);
}
