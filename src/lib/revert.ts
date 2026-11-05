/**
 * Undoing a hand edit: the field goes back to what the edit replaced, and
 * the override goes, so imports and lookups may fill it again. Only fields
 * listed here can be reverted; each maps to the columns it set.
 */

import { env } from 'cloudflare:workers';
import { EditError } from './edits';
import type { CreditSnapshot } from './credits';

type Entity = 'release_group' | 'release' | 'recording' | 'artist';

/** field -> columns (one, or a date with its precision). */
const FIELDS: Record<Entity, Record<string, string[]>> = {
  release_group: {
    title: ['title'],
    type: ['type'],
    status: ['status'],
    availability: ['availability'],
    preferred_release_id: ['preferred_release_id'],
    spotify_id: ['spotify_id'],
    first_release_date: ['first_release_date', 'date_precision'],
    credits: [],
  },
  release: { title: ['title'], label: ['label'], format: ['format'], note: ['note'], date: ['date', 'date_precision'] },
  recording: { title: ['title'], spotify_id: ['spotify_id'], credits: [] },
  artist: {
    name: ['name'],
    sort_name: ['sort_name'],
    disambiguation: ['disambiguation'],
    kind: ['kind'],
    area: ['area'],
    begin_date: ['begin_date', 'begin_precision'],
    end_date: ['end_date', 'end_precision'],
  },
};

export function parseRevert(value: string): { entity: Entity; id: string; field: string } {
  const [entity, id, field] = value.split(':');
  if (!entity || !id || !field || !Object.hasOwn(FIELDS, entity) || !Object.hasOwn(FIELDS[entity as Entity], field)) {
    throw new EditError('That cannot be undone.');
  }
  return { entity: entity as Entity, id, field };
}

export async function revertEdit(entity: Entity, id: string, field: string): Promise<void> {
  const columns = FIELDS[entity]?.[field];
  if (!columns) throw new EditError('That cannot be undone.');
  const row = await env.DB.prepare(`SELECT original_json FROM field_override WHERE entity_type = ? AND entity_id = ? AND field = ?`)
    .bind(entity, id, field)
    .first<{ original_json: string | null }>();
  if (!row) throw new EditError('That is no longer edited.');
  if (row.original_json === null) throw new EditError('This edit was made before undo existed, so what it replaced is not known.');
  const original = JSON.parse(row.original_json) as unknown;
  const db = env.DB;
  const statements: D1PreparedStatement[] = [];

  if (field === 'credits') {
    const credits = original as CreditSnapshot;
    statements.push(db.prepare(`DELETE FROM artist_credit WHERE entity_type = ? AND entity_id = ?`).bind(entity, id));
    for (const c of credits) {
      statements.push(
        db.prepare(
          `INSERT INTO artist_credit (id, entity_type, entity_id, artist_id, role, position, credited_as, join_phrase)
           SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM artist WHERE id = ?4) ON CONFLICT DO NOTHING`,
        ).bind(crypto.randomUUID(), entity, id, c.artist_id, c.role, c.position, c.credited_as, c.join_phrase),
      );
    }
  } else if (columns.length === 2) {
    const d = original as { date: string | null; precision: string };
    statements.push(db.prepare(`UPDATE ${entity} SET ${columns[0]} = ?, ${columns[1]} = ? WHERE id = ?`).bind(d.date, d.precision, id));
  } else {
    if (field === 'spotify_id' && original) {
      const taken = await db.prepare(`SELECT 1 AS yes FROM ${entity} WHERE spotify_id = ? AND id <> ?`).bind(original, id).first();
      if (taken) throw new EditError('Something else now holds that Spotify link, so it cannot go back.');
    }
    statements.push(db.prepare(`UPDATE ${entity} SET ${columns[0]} = ? WHERE id = ?`).bind(original as string | null, id));
  }
  statements.push(db.prepare(`DELETE FROM field_override WHERE entity_type = ? AND entity_id = ? AND field = ?`).bind(entity, id, field));
  await db.batch(statements);
}

/** field -> whether it can be undone, for an entity's edit page. */
export async function editsOf(entity: Entity, id: string): Promise<Map<string, boolean>> {
  const { results } = await env.DB.prepare(`SELECT field, original_json IS NOT NULL AS known FROM field_override WHERE entity_type = ? AND entity_id = ?`)
    .bind(entity, id)
    .all<{ field: string; known: number }>();
  return new Map(results.map((r) => [r.field, r.known === 1]));
}
