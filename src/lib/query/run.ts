/**
 * Runs a compiled definition and loads display rows for the results.
 * Selection is entirely compile()'s; this only fetches what to show for
 * the ids it chose, in the order it chose them.
 */

import { env } from 'cloudflare:workers';
import { artistLines, releaseGroupsByIds, type CreditPart, type ReleaseGroupSummary } from '../catalogue';
import { compile, type CompileOptions } from './compile';
import { ENTITIES } from './fields';
import type { Definition } from './schema';

export interface TrackResult {
  kind: 'recording';
  id: string;
  title: string;
  length_ms: number | null;
  quality_score: number | null;
  personal_score: number | null;
  album_id: string | null;
  album_title: string | null;
  art_key: string | null;
  spotify_id: string | null;
  credits: CreditPart[];
}

export interface AlbumResult extends ReleaseGroupSummary {
  kind: 'release_group';
}

export interface ArtistResult {
  kind: 'artist';
  id: string;
  name: string;
  album_count: number;
  avg_rating: number | null;
  rated_track_count: number;
  avg_track_rating: number | null;
}

export type QueryResult = TrackResult | AlbumResult | ArtistResult;

/** The ordered ids a definition selects. Shared by every caller. */
export async function selectIds(definition: Definition, options: CompileOptions): Promise<string[]> {
  const { sql, params } = compile(definition, options);
  const { results } = await env.DB.prepare(sql)
    .bind(...params)
    .all<{ id: string }>();
  return results.map((row) => row.id);
}

function inOrder<T extends { id: string }>(ids: string[], rows: T[]): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is T => row !== undefined);
}

/** Display rows for tracks, in the order given. */
export async function hydrateTracks(ids: string[], userId: string | null): Promise<TrackResult[]> {
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.title, e.length_ms, e.spotify_id, s.quality_score, s.personal_score,
            ag.id AS album_id, ag.title AS album_title, r.art_key
     FROM recording e
     LEFT JOIN v_recording_score s ON s.recording_id = e.id AND s.user_id = ?1
     LEFT JOIN v_recording_album ra ON ra.recording_id = e.id
     LEFT JOIN release_group ag ON ag.id = ra.release_group_id
     LEFT JOIN v_release_group_canonical c ON c.release_group_id = ag.id
     LEFT JOIN release r ON r.id = c.release_id
     WHERE e.id IN (SELECT value FROM json_each(?2))`,
  )
    .bind(userId, JSON.stringify(ids))
    .all<Omit<TrackResult, 'kind' | 'credits'>>();
  const lines = await artistLines('recording', ids);
  return inOrder(ids, results).map((row) => ({ ...row, kind: 'recording', credits: lines.get(row.id) ?? [] }));
}

async function hydrateArtists(ids: string[], userId: string | null): Promise<ArtistResult[]> {
  const fields = ENTITIES.artist.fields;
  const { results } = await env.DB.prepare(
    `WITH params AS (SELECT ?1 AS user_id)
     SELECT e.id, e.name,
            ${fields.album_count!.sql} AS album_count,
            ${fields.avg_rating!.sql} AS avg_rating,
            ${fields.rated_track_count!.sql} AS rated_track_count,
            ${fields.avg_track_rating!.sql} AS avg_track_rating
     ${ENTITIES.artist.from}
     WHERE e.id IN (SELECT value FROM json_each(?2))`,
  )
    .bind(userId, JSON.stringify(ids))
    .all<Omit<ArtistResult, 'kind'>>();
  return inOrder(ids, results).map((row) => ({ ...row, kind: 'artist' }));
}

export async function runDefinition(definition: Definition, options: CompileOptions): Promise<QueryResult[]> {
  const ids = await selectIds(definition, options);
  if (ids.length === 0) return [];

  switch (definition.entity) {
    case 'recording':
      return hydrateTracks(ids, options.userId);
    case 'release_group':
      return inOrder(ids, await releaseGroupsByIds(ids, options.userId)).map((row) => ({
        ...row,
        kind: 'release_group' as const,
      }));
    case 'artist':
      return hydrateArtists(ids, options.userId);
  }
}
