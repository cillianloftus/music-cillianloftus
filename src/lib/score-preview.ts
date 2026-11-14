/**
 * What a rating form needs to show the score it gives as it is moved
 * (src/lib/client/rating-preview.ts), by the views' own rules:
 *
 * - a track: its gut conversion (gut-calibration.ts): the gap at each gut
 *   score, plus this song's artist and genre adjustment;
 * - an album: what its rated tracks give (the score without the album
 *   rating), so the album rating can be blended in live as the view does.
 */

import { env } from 'cloudflare:workers';
import { albumScores } from './album-scores';
import { genresOfRecordings } from './genres';
import { keptCalibration } from './gut-calibration';
import type { RatableEntity, RatingRow } from './ratings';
import { albumComposite, convert, type Weights } from './scoring';

export interface ScorePreview {
  entityType: RatableEntity;
  weights: Weights;
  /** The general gut gap, for an album's gut score and a track with no conversion yet. */
  offset: number;
  /** A track's conversion: the gap at gut 0 … 10, and its artist and genre adjustment. */
  conversion?: { levels: number[]; extra: number; artist: number; genre: number };
  /** An album's tracks part (0–100), or null when no track is rated. */
  tracks?: number | null;
}

export async function scorePreview(
  userId: string,
  entityType: RatableEntity,
  id: string,
  current: RatingRow | undefined,
  weights: Weights,
): Promise<ScorePreview> {
  const offset =
    (await env.DB.prepare('SELECT gut_offset FROM v_gut_calibration WHERE user_id = ?').bind(userId).first<number>('gut_offset')) ?? 0;

  if (entityType === 'recording') {
    const cal = await keptCalibration(userId);
    if (!cal) return { entityType, weights, offset };
    const [artist, genres] = await env.DB.batch([
      env.DB.prepare(
        `SELECT artist_id FROM artist_credit WHERE entity_type = 'recording' AND entity_id = ? AND role = 'primary' ORDER BY position LIMIT 1`,
      ).bind(id),
      env.DB.prepare(`WITH one AS (SELECT ? AS recording_id) ${genresOfRecordings('one')}`).bind(id),
    ]);
    const parts = convert(
      cal,
      0,
      (artist!.results[0] as { artist_id: string } | undefined)?.artist_id,
      (genres!.results as { genre_id: string }[]).map((g) => g.genre_id),
    );
    return { entityType, weights, offset, conversion: { levels: cal.levels, extra: parts.artist + parts.genre, artist: parts.artist, genre: parts.genre } };
  }

  // An album: its score now, less what the album rating adds to it.
  const score = (await albumScores(userId))[id];
  if (!score || score.rated === 0) return { entityType, weights, offset, tracks: null };
  const axes = current
    ? { sequencing: current.sequencing, cohesion: current.cohesion, ambition: current.ambition }
    : {};
  const ownBase = current ? (albumComposite(axes, weights) ?? (current.gut_score == null ? null : current.gut_score + offset)) : null;
  const { tracks: wt, album_axes: wa } = weights.release;
  const tracks = ownBase == null ? score.quality : (score.quality * (wt + wa) - wa * 10 * ownBase) / wt;
  return { entityType, weights, offset, tracks: Math.max(0, Math.min(100, tracks)) };
}
