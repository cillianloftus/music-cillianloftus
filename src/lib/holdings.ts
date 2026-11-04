/**
 * The physical collection (ARCHITECTURE.md §3, "Ownership and files"):
 * which editions are owned, in what format. Separate from availability,
 * so "rated above 85, for sale, not owned" is a shopping list.
 *
 * Unlike ratings these are facts that stop being true: a record sold is
 * removed, so holdings can be deleted.
 */

import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { parsePartialDate } from './dates';

export const HOLDING_FORMATS = ['vinyl', 'cd', 'cassette', 'digital'] as const;
export type HoldingFormat = (typeof HOLDING_FORMATS)[number];

export const FORMAT_LABELS: Record<HoldingFormat, string> = {
  vinyl: 'Vinyl',
  cd: 'CD',
  cassette: 'Cassette',
  digital: 'Digital',
};

/** "Yours on vinyl", "Yours as a digital copy". */
export const OWNED_PHRASE: Record<HoldingFormat, string> = {
  vinyl: 'Yours on vinyl',
  cd: 'Yours on CD',
  cassette: 'Yours on cassette',
  digital: 'Yours as a digital copy',
};

export const holdingInput = z
  .object({
    release_id: z.string().min(1).max(64),
    format: z.enum(HOLDING_FORMATS),
    acquired: z
      .string()
      .trim()
      .max(10)
      .default('')
      .refine((v) => v === '' || parsePartialDate(v).precision !== 'unknown', 'Write when as 2015, 2015-06 or 2015-06-30, or leave it empty.'),
    notes: z.string().trim().max(300).default(''),
  })
  .strict();

export interface Holding {
  id: string;
  release_id: string;
  format: HoldingFormat;
  acquired_at: string | null;
  date_precision: string;
  notes: string | null;
}

/** This user's holdings of any edition of an album. */
export async function holdingsFor(userId: string, releaseGroupId: string): Promise<Holding[]> {
  const { results } = await env.DB.prepare(
    `SELECT h.id, h.release_id, h.format, h.acquired_at, h.date_precision, h.notes
     FROM holding h JOIN release r ON r.id = h.release_id
     WHERE h.user_id = ? AND r.release_group_id = ?
     ORDER BY h.acquired_at IS NULL, h.acquired_at, h.id`,
  )
    .bind(userId, releaseGroupId)
    .all<Holding>();
  return results;
}

/** Returns the album it belongs to, for the redirect back; null if the edition is unknown. */
export async function addHolding(userId: string, input: z.infer<typeof holdingInput>): Promise<string | null> {
  const release = await env.DB.prepare(`SELECT release_group_id FROM release WHERE id = ?`)
    .bind(input.release_id)
    .first<{ release_group_id: string }>();
  if (!release) return null;
  const date = parsePartialDate(input.acquired);
  await env.DB.prepare(
    `INSERT INTO holding (id, user_id, release_id, format, acquired_at, date_precision, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), userId, input.release_id, input.format, date.date, date.precision, input.notes || null)
    .run();
  return release.release_group_id;
}

/** Only the user's own. Returns the album it was on, or null if there was nothing to remove. */
export async function removeHolding(userId: string, id: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT r.release_group_id FROM holding h JOIN release r ON r.id = h.release_id WHERE h.id = ? AND h.user_id = ?`,
  )
    .bind(id, userId)
    .first<{ release_group_id: string }>();
  if (!row) return null;
  await env.DB.prepare(`DELETE FROM holding WHERE id = ? AND user_id = ?`).bind(id, userId).run();
  return row.release_group_id;
}
