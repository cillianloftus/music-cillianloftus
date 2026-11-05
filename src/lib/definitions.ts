/**
 * Saved definitions: a playlist is a saved query, not a list of tracks
 * (ARCHITECTURE.md §3, Playlist definitions).
 */

import { env } from 'cloudflare:workers';
import { definitionSchema, type Definition } from './query/schema';

export interface DefinitionRow {
  id: string;
  user_id: string;
  owner_name: string;
  name: string;
  description: string | null;
  query_json: string;
  spotify_playlist_id: string | null;
  /** The cover as last rasterised for Spotify, in R2. */
  art_key: string | null;
  /** 'uploaded' when Cillian chose the cover; otherwise it is drawn from the contents. */
  art_mode: 'generated' | 'uploaded';
  created_at: string;
  updated_at: string;
}

export interface SavedDefinition extends DefinitionRow {
  definition: Definition;
  pins: string[];
  excludes: string[];
}

const SELECT = `
  SELECT d.id, d.user_id, u.display_name AS owner_name, d.name, d.description, d.query_json,
         d.spotify_playlist_id, d.art_key, d.art_mode, d.created_at, d.updated_at
  FROM definition d JOIN app_user u ON u.id = d.user_id`;

export async function listDefinitions(): Promise<DefinitionRow[]> {
  const { results } = await env.DB.prepare(`${SELECT} ORDER BY d.updated_at DESC`).all<DefinitionRow>();
  return results;
}

export async function getDefinition(id: string): Promise<SavedDefinition | null> {
  const row = await env.DB.prepare(`${SELECT} WHERE d.id = ?`).bind(id).first<DefinitionRow>();
  if (!row) return null;

  const [pins, excludes] = await env.DB.batch<{ recording_id: string }>([
    env.DB.prepare('SELECT recording_id FROM definition_pin WHERE definition_id = ?').bind(id),
    env.DB.prepare('SELECT recording_id FROM definition_exclude WHERE definition_id = ?').bind(id),
  ]);

  // Stored definitions were validated on save; parsing again applies
  // defaults and guards against rows edited by hand in the database.
  const definition = definitionSchema.parse(JSON.parse(row.query_json));
  return {
    ...row,
    definition,
    pins: pins!.results.map((r) => r.recording_id),
    excludes: excludes!.results.map((r) => r.recording_id),
  };
}

export interface DefinitionInput {
  name: string;
  description: string | null;
  definition: Definition;
}

export async function createDefinition(userId: string, input: DefinitionInput): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO definition (id, user_id, name, description, query_json) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(id, userId, input.name, input.description, JSON.stringify(input.definition))
    .run();
  return id;
}

export async function updateDefinition(id: string, input: DefinitionInput): Promise<void> {
  await env.DB.prepare(
    `UPDATE definition
     SET name = ?, description = ?, query_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
  )
    .bind(input.name, input.description, JSON.stringify(input.definition), id)
    .run();
}
