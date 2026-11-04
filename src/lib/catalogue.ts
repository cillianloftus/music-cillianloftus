/**
 * Read queries for public catalogue pages. Scores come from the views in
 * migrations/0003 for one viewer: the signed-in user, else the owner.
 */

import { env } from 'cloudflare:workers';
import type { DatePrecision } from './dates';
import type { CreditEntity, CreditRole, ReleaseGroupType } from './import/plan';

export interface CreditPart {
  entity_id: string;
  artist_id: string;
  name: string;
  role: CreditRole;
  join_phrase: string;
}

export interface Score {
  quality_score: number;
  personal_score: number;
}

export interface ReleaseGroupSummary extends Partial<Score> {
  id: string;
  title: string;
  type: ReleaseGroupType;
  status: 'announced' | 'released' | 'cancelled';
  first_release_date: string | null;
  date_precision: DatePrecision;
  art_key: string | null;
  credits: CreditPart[];
}

const json = (value: unknown) => JSON.stringify(value);

/**
 * The displayed artist line (primary, then featured) for many entities in
 * one query, in credit order with join phrases intact.
 */
export async function artistLines(
  entityType: CreditEntity,
  ids: string[],
): Promise<Map<string, CreditPart[]>> {
  const lines = new Map<string, CreditPart[]>();
  if (ids.length === 0) return lines;

  const { results } = await env.DB.prepare(
    `SELECT c.entity_id, c.artist_id, coalesce(c.credited_as, a.name) AS name, c.role, c.join_phrase
     FROM artist_credit c
     JOIN artist a ON a.id = c.artist_id
     WHERE c.entity_type = ?1
       AND c.entity_id IN (SELECT value FROM json_each(?2))
       AND c.role IN ('primary', 'featured')
     ORDER BY c.entity_id, c.role = 'featured', c.position`,
  )
    .bind(entityType, json(ids))
    .all<CreditPart>();

  for (const part of results) {
    const line = lines.get(part.entity_id) ?? [];
    line.push(part);
    lines.set(part.entity_id, line);
  }
  return lines;
}

/** Follows a merge redirect, if the id was merged away. */
export async function redirectFor(entityType: string, id: string): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT new_id FROM entity_redirect WHERE entity_type = ? AND old_id = ?',
  )
    .bind(entityType, id)
    .first<{ new_id: string }>();
  return row?.new_id ?? null;
}

const SUMMARY_COLUMNS = `
  g.id, g.title, g.type, g.status, g.first_release_date, g.date_precision,
  r.art_key, s.quality_score, s.personal_score`;

const SUMMARY_JOINS = `
  LEFT JOIN v_release_group_canonical c ON c.release_group_id = g.id
  LEFT JOIN release r ON r.id = c.release_id
  LEFT JOIN v_release_score s ON s.release_group_id = g.id AND s.user_id = ?1`;

async function withArtistLines(
  rows: Omit<ReleaseGroupSummary, 'credits'>[],
): Promise<ReleaseGroupSummary[]> {
  const lines = await artistLines('release_group', rows.map((row) => row.id));
  return rows.map((row) => ({ ...row, credits: lines.get(row.id) ?? [] }));
}

export async function recentReleaseGroups(viewerId: string | null, limit = 24): Promise<ReleaseGroupSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${SUMMARY_COLUMNS}
     FROM release_group g ${SUMMARY_JOINS}
     ORDER BY g.created_at DESC
     LIMIT ?2`,
  )
    .bind(viewerId, limit)
    .all<Omit<ReleaseGroupSummary, 'credits'>>();
  return withArtistLines(results);
}

export async function releaseGroupsByIds(ids: string[], viewerId: string | null): Promise<ReleaseGroupSummary[]> {
  if (ids.length === 0) return [];
  const { results } = await env.DB.prepare(
    `SELECT ${SUMMARY_COLUMNS}
     FROM release_group g ${SUMMARY_JOINS}
     WHERE g.id IN (SELECT value FROM json_each(?2))`,
  )
    .bind(viewerId, JSON.stringify(ids))
    .all<Omit<ReleaseGroupSummary, 'credits'>>();
  return withArtistLines(results);
}

export interface ReleaseGroupDetail extends ReleaseGroupSummary {
  mbid: string | null;
  availability: string | null;
  canonical_release_id: string | null;
  rated_track_count: number | null;
  track_count: number | null;
  impact_note: string | null;
}

export async function releaseGroup(id: string, viewerId: string | null): Promise<ReleaseGroupDetail | null> {
  const row = await env.DB.prepare(
    `SELECT ${SUMMARY_COLUMNS}, g.mbid, g.availability, c.release_id AS canonical_release_id,
            s.rated_track_count, s.track_count,
            (SELECT lr.impact_note FROM rating lr
             WHERE lr.user_id = ?1 AND lr.entity_type = 'release_group' AND lr.entity_id = g.id
             ORDER BY lr.rated_at DESC LIMIT 1) AS impact_note
     FROM release_group g ${SUMMARY_JOINS}
     WHERE g.id = ?2`,
  )
    .bind(viewerId, id)
    .first<Omit<ReleaseGroupDetail, 'credits'>>();
  if (!row) return null;
  const [withLine] = await withArtistLines([row]);
  return withLine as ReleaseGroupDetail;
}

export interface TrackRow extends Partial<Score> {
  id: string;
  disc: number;
  position: number;
  title: string;
  recording_id: string;
  length_ms: number | null;
  depth: 'gut' | 'detailed' | null;
  credits: CreditPart[];
}

export async function tracklist(releaseId: string, viewerId: string | null): Promise<TrackRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.disc, t.position, coalesce(t.title_on_release, rec.title) AS title,
            rec.id AS recording_id, rec.length_ms,
            s.quality_score, s.personal_score, s.depth
     FROM track t
     JOIN recording rec ON rec.id = t.recording_id
     LEFT JOIN v_recording_score s ON s.recording_id = rec.id AND s.user_id = ?2
     WHERE t.release_id = ?1
     ORDER BY t.disc, t.position`,
  )
    .bind(releaseId, viewerId)
    .all<Omit<TrackRow, 'credits'>>();

  const lines = await artistLines('recording', results.map((row) => row.recording_id));
  return results.map((row) => ({ ...row, credits: lines.get(row.recording_id) ?? [] }));
}

export interface Edition {
  id: string;
  title: string;
  date: string | null;
  date_precision: DatePrecision;
  country: string | null;
  label: string | null;
  format: string | null;
  mbid: string | null;
  art_key: string | null;
  track_count: number;
}

/** Ordered the same way v_release_group_canonical chooses, so the standard edition comes first. */
export async function editions(releaseGroupId: string): Promise<Edition[]> {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.title, r.date, r.date_precision, r.country, r.label, r.format, r.mbid, r.art_key,
            (SELECT count(*) FROM track t WHERE t.release_id = r.id) AS track_count
     FROM release r
     WHERE r.release_group_id = ?
     ORDER BY r.date IS NULL, substr(r.date || '-99-99', 1, 10), track_count, r.created_at, r.id`,
  )
    .bind(releaseGroupId)
    .all<Edition>();
  return results;
}

export interface Genre {
  id: string;
  name: string;
}

export async function genresFor(entityType: 'release_group' | 'recording', id: string): Promise<Genre[]> {
  // Manual tags win: when any exist, other sources are not shown.
  const { results } = await env.DB.prepare(
    `WITH tags AS (
       SELECT t.genre_id, t.source, t.weight FROM genre_tag t
       WHERE t.entity_type = ?1 AND t.entity_id = ?2
     )
     SELECT g.id, g.name
     FROM tags t JOIN genre g ON g.id = t.genre_id
     WHERE t.source = 'manual' OR NOT EXISTS (SELECT 1 FROM tags WHERE source = 'manual')
     GROUP BY g.id
     ORDER BY max(t.source = 'manual') DESC, max(t.weight) DESC, g.name
     LIMIT 6`,
  )
    .bind(entityType, id)
    .all<Genre>();
  return results;
}

export interface Contributor {
  artist_id: string;
  name: string;
  role: CreditRole;
}

/** Producers, writers, engineers and so on across an edition and its recordings. */
export async function contributors(releaseId: string): Promise<Contributor[]> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT a.id AS artist_id, a.name, c.role
     FROM artist_credit c
     JOIN artist a ON a.id = c.artist_id
     WHERE c.role NOT IN ('primary', 'featured')
       AND ((c.entity_type = 'release' AND c.entity_id = ?1)
         OR (c.entity_type = 'recording'
             AND c.entity_id IN (SELECT recording_id FROM track WHERE release_id = ?1)))
     ORDER BY c.role, a.sort_name`,
  )
    .bind(releaseId)
    .all<Contributor>();
  return results;
}

export interface ArtistDetail {
  id: string;
  name: string;
  disambiguation: string | null;
  mbid: string | null;
}

export async function artist(id: string): Promise<ArtistDetail | null> {
  return env.DB.prepare('SELECT id, name, disambiguation, mbid FROM artist WHERE id = ?')
    .bind(id)
    .first<ArtistDetail>();
}

export async function artistReleaseGroups(artistId: string, viewerId: string | null): Promise<ReleaseGroupSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${SUMMARY_COLUMNS}
     FROM release_group g ${SUMMARY_JOINS}
     WHERE g.id IN (
       SELECT entity_id FROM artist_credit
       WHERE entity_type = 'release_group' AND artist_id = ?2 AND role IN ('primary', 'featured')
     )
     ORDER BY g.first_release_date IS NULL, g.first_release_date`,
  )
    .bind(viewerId, artistId)
    .all<Omit<ReleaseGroupSummary, 'credits'>>();
  return withArtistLines(results);
}

/** Credits on other people's records: production, writing, features. */
export async function artistAppearances(artistId: string): Promise<{ role: CreditRole; count: number }[]> {
  const { results } = await env.DB.prepare(
    `SELECT role, count(DISTINCT entity_id) AS count
     FROM artist_credit
     WHERE artist_id = ? AND role <> 'primary'
     GROUP BY role ORDER BY count DESC`,
  )
    .bind(artistId)
    .all<{ role: CreditRole; count: number }>();
  return results;
}
