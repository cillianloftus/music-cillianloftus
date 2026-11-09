/**
 * Rating writes. Append-only: every submission is a new row, and the
 * latest row is the current rating (migrations/0001).
 */

import { env } from 'cloudflare:workers';
import { z } from 'zod';

/**
 * Production was one axis until 8 Nov 2026; it is now arrangement and sound
 * (migrations/0042). Originality joined the same day (0045).
 */
export const CRAFT_AXES = ['arrangement', 'sound', 'songwriting', 'lyrics', 'performance', 'originality'] as const;
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
    /** Axes that do not apply (an instrumental has no lyrics): left out, and remembered as such. */
    not_applicable: z.array(z.enum([...CRAFT_AXES, ...ALBUM_AXES])).max(CRAFT_AXES.length + ALBUM_AXES.length).default([]),
  })
  .superRefine((input, ctx) => {
    const forbidden = input.entity_type === 'recording' ? ALBUM_AXES : CRAFT_AXES;
    for (const axis of input.not_applicable) {
      if (input[axis] !== null) {
        ctx.addIssue({ code: 'custom', path: [axis], message: `${axis[0]!.toUpperCase()}${axis.slice(1)} is marked as not applying, so it cannot have a score.` });
      }
    }
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

/**
 * Form fields to rating input: a ticked "na_lyrics" box marks lyrics as not
 * applying and clears any score given for it, since the box is the later,
 * more deliberate statement.
 */
export function ratingFormFields(form: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...form };
  const notApplicable = [...CRAFT_AXES, ...ALBUM_AXES].filter((axis) => form[`na_${axis}`] === 'on');
  for (const axis of notApplicable) {
    fields[axis] = '';
    delete fields[`na_${axis}`];
  }
  for (const key of Object.keys(fields)) if (key.startsWith('na_')) delete fields[key];
  fields.not_applicable = notApplicable;
  return fields;
}

export async function addRating(userId: string, input: RatingInput): Promise<string> {
  const id = crypto.randomUUID();
  // Depth describes the row truthfully, so it is derived, not submitted.
  const depth = [...CRAFT_AXES, ...ALBUM_AXES].some((axis) => input[axis] !== null) ? 'detailed' : 'gut';

  await env.DB.prepare(
    `INSERT INTO rating (id, user_id, entity_type, entity_id, depth, gut_score,
                         arrangement, sound, songwriting, lyrics, performance, originality,
                         sequencing, cohesion, ambition, impact, impact_note, not_applicable)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      userId,
      input.entity_type,
      input.entity_id,
      depth,
      input.gut_score,
      input.arrangement,
      input.sound,
      input.songwriting,
      input.lyrics,
      input.performance,
      input.originality,
      input.sequencing,
      input.cohesion,
      input.ambition,
      input.impact,
      input.impact_note,
      input.not_applicable.length ? JSON.stringify(input.not_applicable) : null,
    )
    .run();
  // Rated again with every axis (or by gut alone): an older rating's review
  // item is done at once, not at the next check (review.ts, OUTDATED_RATINGS).
  const stillOutdated = depth === 'detailed' && input.originality === null && !input.not_applicable.includes('originality');
  if (input.entity_type === 'recording' && !stillOutdated) {
    await env.DB.prepare(
      `UPDATE anomaly SET status = 'resolved', resolution = 'rerated'
       WHERE kind = 'outdated_rating' AND status = 'open' AND entity_a = ?1
         AND EXISTS (SELECT 1 FROM app_user u WHERE u.id = ?2 AND u.is_owner = 1)`,
    )
      .bind(input.entity_id, userId)
      .run();
  }
  return id;
}

export interface RatingRow {
  id: string;
  rated_at: string;
  depth: 'gut' | 'detailed';
  gut_score: number | null;
  /** Only on rows rated before the split; arrangement and sound below already stand in for it. */
  production: number | null;
  arrangement: number | null;
  sound: number | null;
  songwriting: number | null;
  lyrics: number | null;
  performance: number | null;
  /** None on rows rated before 0045. */
  originality: number | null;
  sequencing: number | null;
  cohesion: number | null;
  ambition: number | null;
  impact: number | null;
  impact_note: string | null;
  /** Axes marked as not applying ("production" on an old row reads as both halves). */
  not_applicable: string[];
}

/** Newest first. The first row is the current rating. */
export async function ratingHistory(
  userId: string,
  entityType: RatableEntity,
  entityId: string,
): Promise<RatingRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, rated_at, depth, gut_score, production,
            coalesce(arrangement, production) AS arrangement, coalesce(sound, production) AS sound,
            songwriting, lyrics, performance, originality,
            sequencing, cohesion, ambition, impact, impact_note, not_applicable
     FROM rating
     WHERE user_id = ? AND entity_type = ? AND entity_id = ?
     ORDER BY rated_at DESC`,
  )
    .bind(userId, entityType, entityId)
    .all<Omit<RatingRow, 'not_applicable'> & { not_applicable: string | null }>();
  return results.map((r) => {
    const na = r.not_applicable ? (JSON.parse(r.not_applicable) as string[]) : [];
    return { ...r, not_applicable: na.flatMap((axis) => (axis === 'production' ? ['arrangement', 'sound'] : [axis])) };
  });
}

/** Only same-site paths, so a crafted form cannot redirect elsewhere. */
export function safeReturnPath(value: unknown, fallback: string): string {
  // "//host" and "/\host" are both read by browsers as another origin.
  return typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value : fallback;
}
