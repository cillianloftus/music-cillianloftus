/**
 * Versioned score weights (ARCHITECTURE.md §3). Saving never edits a
 * version: it adds the next one and makes it active, so any past ranking
 * can be replayed by switching back.
 */

import { env } from 'cloudflare:workers';
import { z } from 'zod';
import {
  ALBUM_KEYS,
  CRAFT_KEYS,
  DEFAULT_WEIGHTS,
  type RatingSample,
  type ScoreInputs,
  type TrackKind,
  type Weights,
} from './scoring';

/** Axis weights run 0–3 in quarter steps; 0 leaves an axis out. */
export const AXIS_WEIGHT = { min: 0, max: 3, step: 0.25 } as const;

const axisWeight = z.coerce.number().min(AXIS_WEIGHT.min).max(AXIS_WEIGHT.max).multipleOf(AXIS_WEIGHT.step);

/**
 * The form: one field per axis, the tracks share as a percentage (the
 * album axes take the rest, so the blend always sums to 1), and a
 * checkbox for trimming the lowest track.
 */
export const weightsForm = z
  .object({
    ...Object.fromEntries([...CRAFT_KEYS, ...ALBUM_KEYS].map((key) => [key, axisWeight])),
    // Older links and forms, from before it existed (0045): the default.
    originality: axisWeight.default(DEFAULT_WEIGHTS.craft.originality),
    tracks_share: z.coerce.number().int().min(0).max(100).multipleOf(5),
    // Older links and forms have neither: they mean the defaults.
    interlude_share: z.coerce.number().int().min(0).max(100).multipleOf(5).default(Math.round(DEFAULT_WEIGHTS.release.interlude * 100)),
    length_share: z.coerce.number().int().min(0).max(100).multipleOf(5).default(Math.round(DEFAULT_WEIGHTS.release.length * 100)),
    trim_lowest: z.preprocess((value) => value === 'on' || value === 'true' || value === true, z.boolean()),
  })
  .transform((form, ctx): Weights => {
    const value = (key: string) => (form as unknown as Record<string, number>)[key]!;
    const weights: Weights = {
      craft: Object.fromEntries(CRAFT_KEYS.map((k) => [k, value(k)])) as Weights['craft'],
      album: Object.fromEntries(ALBUM_KEYS.map((k) => [k, value(k)])) as Weights['album'],
      release: {
        tracks: form.tracks_share / 100,
        album_axes: (100 - form.tracks_share) / 100,
        trim_lowest: form.trim_lowest,
        interlude: form.interlude_share / 100,
        length: form.length_share / 100,
      },
    };
    // With every axis at zero a detailed rating would have no score at all.
    if (CRAFT_KEYS.every((k) => weights.craft[k] === 0)) {
      ctx.addIssue({ code: 'custom', message: 'At least one track axis needs a weight above zero.' });
    }
    if (ALBUM_KEYS.every((k) => weights.album[k] === 0)) {
      ctx.addIssue({ code: 'custom', message: 'At least one album axis needs a weight above zero.' });
    }
    return weights;
  });

/** A payload saved before the split: production's weight is shared by its two halves. */
function legacyCraft(craft: (Partial<Weights['craft']> & { production?: number }) | undefined): Partial<Weights['craft']> {
  if (!craft) return {};
  const { production, ...rest } = craft;
  return production === undefined ? rest : { arrangement: production / 2, sound: production / 2, ...rest };
}

/** A stored payload with the views' defaults filled in, as v_active_weights does. */
export function withDefaults(payload: unknown): Weights {
  const p = (payload ?? {}) as { craft?: Partial<Weights['craft']>; album?: Partial<Weights['album']>; release?: Partial<Weights['release']> };
  const trim = p.release?.trim_lowest;
  return {
    craft: { ...DEFAULT_WEIGHTS.craft, ...legacyCraft(p.craft) },
    album: { ...DEFAULT_WEIGHTS.album, ...p.album },
    release: {
      tracks: p.release?.tracks ?? DEFAULT_WEIGHTS.release.tracks,
      album_axes: p.release?.album_axes ?? DEFAULT_WEIGHTS.release.album_axes,
      trim_lowest: trim === undefined ? DEFAULT_WEIGHTS.release.trim_lowest : Boolean(trim),
      interlude: p.release?.interlude ?? DEFAULT_WEIGHTS.release.interlude,
      length: p.release?.length ?? DEFAULT_WEIGHTS.release.length,
    },
  };
}

export const sameWeights = (a: Weights, b: Weights) => JSON.stringify(a) === JSON.stringify(b);

export interface WeightsVersion {
  id: string;
  version: number;
  active: boolean;
  created_at: string;
  weights: Weights;
}

/** Newest first. */
export async function weightsVersions(userId: string): Promise<WeightsVersion[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, version, active, created_at, payload_json FROM weights WHERE user_id = ? ORDER BY version DESC`,
  )
    .bind(userId)
    .all<{ id: string; version: number; active: number; created_at: string; payload_json: string }>();
  return results.map((r) => ({
    id: r.id,
    version: r.version,
    active: r.active === 1,
    created_at: r.created_at,
    weights: withDefaults(JSON.parse(r.payload_json)),
  }));
}

export async function activeWeights(userId: string): Promise<Weights> {
  const row = await env.DB.prepare(`SELECT payload_json FROM weights WHERE user_id = ? AND active = 1`)
    .bind(userId)
    .first<{ payload_json: string }>();
  return withDefaults(row ? JSON.parse(row.payload_json) : null);
}

/**
 * Adds the next version and makes it active, in one transaction. The old
 * active row is cleared first, because only one may be active at a time.
 * Saving weights identical to the active ones adds nothing.
 */
export async function saveWeights(userId: string, weights: Weights): Promise<number> {
  const versions = await weightsVersions(userId);
  const active = versions.find((v) => v.active);
  if (active && sameWeights(active.weights, weights)) return active.version;
  if (!active && versions.length === 0 && sameWeights(DEFAULT_WEIGHTS, weights)) return 0;

  const version = (versions[0]?.version ?? 0) + 1;
  await env.DB.batch([
    env.DB.prepare(`UPDATE weights SET active = 0 WHERE user_id = ? AND active = 1`).bind(userId),
    env.DB.prepare(`INSERT INTO weights (id, user_id, version, payload_json, active) VALUES (?, ?, ?, ?, 1)`).bind(
      crypto.randomUUID(),
      userId,
      version,
      JSON.stringify(weights),
    ),
  ]);
  return version;
}

/** Makes an earlier version current again. False if it is not this user's. */
export async function activateVersion(userId: string, id: string): Promise<boolean> {
  const exists = await env.DB.prepare(`SELECT 1 AS ok FROM weights WHERE id = ? AND user_id = ?`).bind(id, userId).first();
  if (!exists) return false;
  await env.DB.batch([
    env.DB.prepare(`UPDATE weights SET active = 0 WHERE user_id = ? AND active = 1`).bind(userId),
    env.DB.prepare(`UPDATE weights SET active = 1 WHERE id = ? AND user_id = ?`).bind(id, userId),
  ]);
  return true;
}

type SampleRow = Record<(typeof CRAFT_KEYS)[number] | (typeof ALBUM_KEYS)[number] | 'gut_score' | 'impact', number | null> & {
  entity_type: 'recording' | 'release_group';
  entity_id: string;
  rated_at: string;
};

const sample = (r: SampleRow, keys: readonly ((typeof CRAFT_KEYS)[number] | (typeof ALBUM_KEYS)[number])[]): RatingSample => ({
  gut: r.gut_score,
  impact: r.impact,
  ...Object.fromEntries(keys.map((k) => [k, r[k]])),
});

/**
 * Everything the preview needs to score the library under any weights:
 * small, since it is one person's ratings. Mirrors the views' choices:
 * latest row per entity, calibration over all history, canonical editions.
 */
export async function scoreInputs(userId: string): Promise<ScoreInputs> {
  const [ratings, canonical, tracks] = await env.DB.batch([
    env.DB.prepare(
      `SELECT entity_type, entity_id, rated_at, gut_score, impact,
              coalesce(arrangement, production) AS arrangement, coalesce(sound, production) AS sound,
              songwriting, lyrics, performance, originality, sequencing, cohesion, ambition
       FROM rating WHERE user_id = ? ORDER BY rated_at`,
    ).bind(userId),
    env.DB.prepare(
      `SELECT DISTINCT c.release_group_id, t.recording_id
       FROM v_release_group_canonical c
       JOIN track t ON t.release_id = c.release_id
       WHERE EXISTS (SELECT 1 FROM rating r WHERE r.user_id = ? AND r.entity_type = 'recording' AND r.entity_id = t.recording_id)`,
    ).bind(userId),
    // Kind and length of every rated recording.
    env.DB.prepare(
      `SELECT r.id, r.length_ms, k.kind FROM recording r
       LEFT JOIN recording_kind k ON k.recording_id = r.id
       WHERE r.id IN (SELECT entity_id FROM rating WHERE user_id = ? AND entity_type = 'recording')`,
    ).bind(userId),
  ]);

  const inputs: ScoreInputs = { calibration: [], recordings: {}, albums: {}, canonical: {}, kinds: {}, lengths: {} };
  for (const t of (tracks!.results ?? []) as { id: string; length_ms: number | null; kind: TrackKind | null }[]) {
    if (t.kind && t.kind !== 'song') inputs.kinds![t.id] = t.kind;
    if (t.length_ms != null) inputs.lengths![t.id] = t.length_ms;
  }
  // Oldest first, so later rows overwrite: the last one standing is the latest.
  for (const r of (ratings!.results ?? []) as SampleRow[]) {
    if (r.entity_type === 'recording') {
      const s = sample(r, CRAFT_KEYS);
      // Only rows with both can ever calibrate, whatever the weights.
      if (r.gut_score != null && CRAFT_KEYS.some((k) => r[k] != null)) inputs.calibration.push(s);
      inputs.recordings[r.entity_id] = s;
    } else {
      inputs.albums[r.entity_id] = sample(r, ALBUM_KEYS);
    }
  }
  for (const row of (canonical!.results ?? []) as { release_group_id: string; recording_id: string }[]) {
    (inputs.canonical[row.release_group_id] ??= []).push(row.recording_id);
  }
  return inputs;
}
