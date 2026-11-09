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
