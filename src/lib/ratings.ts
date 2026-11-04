/**
 * Rating writes. Append-only: every submission is a new row, and the
 * latest row is the current rating (migrations/0001).
 */

import { env } from 'cloudflare:workers';
import { z } from 'zod';

export const CRAFT_AXES = ['production', 'songwriting', 'lyrics', 'performance'] as const;
export const ALBUM_AXES = ['sequencing', 'cohesion', 'ambition'] as const;
export type CraftAxis = (typeof CRAFT_AXES)[number];
export type AlbumAxis = (typeof ALBUM_AXES)[number];
export type RatableEntity = 'recording' | 'release_group';

/** "" and absent both mean "not given". Half points are allowed. */
const score = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? null : Number(value)),
  z.number().min(0).max(10).multipleOf(0.5).nullable(),
);

const axes = Object.fromEntries([...CRAFT_AXES, ...ALBUM_AXES].map((axis) => [axis, score])) as Record<
  CraftAxis | AlbumAxis,
  typeof score
>;

export const ratingInput = z
  .object({
    entity_type: z.enum(['recording', 'release_group']),
    entity_id: z.uuid(),
    gut_score: score,
    ...axes,
    impact: score,
    impact_note: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null),
      z.string().max(500).nullable(),
    ),
  })
  .superRefine((input, ctx) => {
    const forbidden = input.entity_type === 'recording' ? ALBUM_AXES : CRAFT_AXES;
    for (const axis of forbidden) {
      if (input[axis] !== null) {
        const what = input.entity_type === 'recording' ? 'a track' : 'an album';
        ctx.addIssue({ code: 'custom', path: [axis], message: `${axis[0]!.toUpperCase()}${axis.slice(1)} does not apply to ${what}.` });
      }
    }
    const anyAxis = [...CRAFT_AXES, ...ALBUM_AXES].some((axis) => input[axis] !== null);
    if (!anyAxis && input.gut_score === null) {
      ctx.addIssue({ code: 'custom', path: ['gut_score'], message: 'Give a gut score or at least one axis.' });
    }
  });

export type RatingInput = z.infer<typeof ratingInput>;

export async function addRating(userId: string, input: RatingInput): Promise<string> {
  const id = crypto.randomUUID();
  // Depth describes the row truthfully, so it is derived, not submitted.
  const depth = [...CRAFT_AXES, ...ALBUM_AXES].some((axis) => input[axis] !== null) ? 'detailed' : 'gut';

  await env.DB.prepare(
    `INSERT INTO rating (id, user_id, entity_type, entity_id, depth, gut_score,
                         production, songwriting, lyrics, performance,
                         sequencing, cohesion, ambition, impact, impact_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      userId,
      input.entity_type,
      input.entity_id,
      depth,
      input.gut_score,
      input.production,
      input.songwriting,
      input.lyrics,
      input.performance,
      input.sequencing,
      input.cohesion,
      input.ambition,
      input.impact,
      input.impact_note,
    )
    .run();
  return id;
}

export interface RatingRow {
  id: string;
  rated_at: string;
  depth: 'gut' | 'detailed';
  gut_score: number | null;
  production: number | null;
  songwriting: number | null;
  lyrics: number | null;
  performance: number | null;
  sequencing: number | null;
  cohesion: number | null;
  ambition: number | null;
  impact: number | null;
  impact_note: string | null;
}

/** Newest first. The first row is the current rating. */
export async function ratingHistory(
  userId: string,
  entityType: RatableEntity,
  entityId: string,
): Promise<RatingRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, rated_at, depth, gut_score, production, songwriting, lyrics, performance,
            sequencing, cohesion, ambition, impact, impact_note
     FROM rating
     WHERE user_id = ? AND entity_type = ? AND entity_id = ?
     ORDER BY rated_at DESC`,
  )
    .bind(userId, entityType, entityId)
    .all<RatingRow>();
  return results;
}

/** Only same-site paths, so a crafted form cannot redirect elsewhere. */
export function safeReturnPath(value: unknown, fallback: string): string {
  // "//host" and "/\host" are both read by browsers as another origin.
  return typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value : fallback;
}
