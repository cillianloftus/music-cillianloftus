/**
 * The field registry: everything a definition may name, per entity, with
 * the SQL each name stands for. A definition can only reach the database
 * through these expressions, so this file is the whole vocabulary of the
 * query layer (ARCHITECTURE.md §4). The model, the validator, the compiler
 * and the reference shown on the definition editor all read from here.
 *
 * SQL here is fixed text written by hand; user values never appear in it.
 * Expressions use the aliases set up by each entity's `from`, and
 * `(SELECT user_id FROM params)` for the user whose scores are in play.
 */

import type { CreditRole } from '../import/plan';

export type Entity = 'recording' | 'release_group' | 'artist';

export type FieldType = 'number' | 'text' | 'date' | 'enum' | 'boolean' | 'genre' | 'credit';

export type Op =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'not_in'
  | 'contains'
  | 'in_tree'
  | 'is_null'
  | 'is_not_null'
  | 'between';

export const OPS_BY_TYPE: Record<FieldType, readonly Op[]> = {
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'not_in', 'is_null', 'is_not_null'],
  text: ['eq', 'neq', 'contains', 'in', 'not_in', 'is_null', 'is_not_null'],
  date: ['eq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'is_not_null'],
  enum: ['eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null'],
  boolean: ['eq'],
  genre: ['in_tree', 'eq', 'in'],
  credit: ['eq', 'contains', 'in', 'not_in'],
};

export interface Field {
  label: string;
  type: FieldType;
  /** The value expression. Absent for fields that only filter (genre, credits). */
  sql?: string;
  sortable: boolean;
  values?: readonly string[];
  /** For credit fields: which roles, and whether to look through to tracks. */
  credit?: { roles: readonly CreditRole[]; deep: boolean };
  description?: string;
}

export interface GroupKey {
  label: string;
  sql: string;
}

export interface EntitySpec {
  label: string;
  /** FROM clause and joins. The entity's row alias is `e`. */
  from: string;
  /** Predicate on artist_credit `c` matching credits on this entity itself. */
  ownCredit?: string;
  /** As ownCredit, but also its editions and the recordings on its standard edition. */
  deepCredit?: string;
  /** Predicate on a genre view matching this entity; `{genres}` is the genre id set. */
  genre?: string;
  /** Expression for a recording's work, enabling collapse_by_work. */
  work?: string;
  fields: Record<string, Field>;
  groups: Record<string, GroupKey>;
}

const USER = '(SELECT user_id FROM params)';

const DATE_PADDED = (expr: string) => `substr(${expr} || '-01-01', 1, 10)`;

const RECORDING_PRIMARY_ARTIST = (column: string) => `(
  SELECT a.${column} FROM artist_credit c JOIN artist a ON a.id = c.artist_id
  WHERE c.entity_type = 'recording' AND c.entity_id = e.id AND c.role = 'primary'
  ORDER BY c.position LIMIT 1)`;

const RELEASE_GROUP_PRIMARY_ARTIST = (column: string) => `(
  SELECT a.${column} FROM artist_credit c JOIN artist a ON a.id = c.artist_id
  WHERE c.entity_type = 'release_group' AND c.entity_id = e.id AND c.role = 'primary'
  ORDER BY c.position LIMIT 1)`;

const CREDIT_FIELDS: Record<string, Field> = {
  producer: { label: 'Producer', type: 'credit', sortable: false, credit: { roles: ['producer'], deep: true } },
  writer: { label: 'Writer', type: 'credit', sortable: false, credit: { roles: ['writer'], deep: true } },
  featured: { label: 'Featured artist', type: 'credit', sortable: false, credit: { roles: ['featured'], deep: true } },
  remixer: { label: 'Remixer', type: 'credit', sortable: false, credit: { roles: ['remixer'], deep: true } },
  engineer: { label: 'Engineer', type: 'credit', sortable: false, credit: { roles: ['engineer', 'mixer'], deep: true } },
  performer: { label: 'Performer', type: 'credit', sortable: false, credit: { roles: ['performer'], deep: true } },
};

const RELEASE_GROUP_TYPES = ['album', 'ep', 'single', 'compilation', 'mixtape', 'soundtrack', 'live'] as const;

export const ENTITIES: Record<Entity, EntitySpec> = {
  recording: {
    label: 'Tracks',
    from: `
      FROM recording e
      LEFT JOIN v_recording_score s ON s.recording_id = e.id AND s.user_id = ${USER}
      LEFT JOIN v_recording_album ra ON ra.recording_id = e.id
      LEFT JOIN release_group ag ON ag.id = ra.release_group_id`,
    ownCredit: `c.entity_type = 'recording' AND c.entity_id = e.id`,
    deepCredit: `c.entity_type = 'recording' AND c.entity_id = e.id`,
    genre: `EXISTS (SELECT 1 FROM v_recording_genre vg WHERE vg.recording_id = e.id AND vg.genre_id IN ({genres}))`,
    work: 'e.work_id',
    fields: {
      title: { label: 'Title', type: 'text', sql: 'e.title', sortable: true },
      artist: {
        label: 'Artist',
        type: 'credit',
        sortable: true,
        sql: RECORDING_PRIMARY_ARTIST('sort_name'),
        credit: { roles: ['primary', 'featured'], deep: false },
      },
      album: { label: 'Album', type: 'text', sql: 'ag.title', sortable: true },
      album_type: { label: 'Album type', type: 'enum', sql: 'ag.type', values: RELEASE_GROUP_TYPES, sortable: false },
      first_release_date: {
        label: 'Released',
        type: 'date',
        sql: 'coalesce(e.first_release_date, ag.first_release_date)',
        sortable: true,
      },
      length_seconds: { label: 'Length (seconds)', type: 'number', sql: 'e.length_ms / 1000.0', sortable: true },
      quality_score: { label: 'Quality score', type: 'number', sql: 's.quality_score', sortable: true },
      personal_score: { label: 'Personal score', type: 'number', sql: 's.personal_score', sortable: true },
      impact: { label: 'Impact', type: 'number', sql: '(s.personal_score - s.quality_score)', sortable: true },
      depth: { label: 'Rating depth', type: 'enum', sql: 's.depth', values: ['gut', 'detailed'], sortable: false },
      play_count: {
        label: 'Play count',
        type: 'number',
        sql: `(SELECT count(*) FROM play p WHERE p.recording_id = e.id AND p.user_id = ${USER} AND p.counted = 1)`,
        sortable: true,
      },
      days_since_release: {
        label: 'Days since release',
        type: 'number',
        sql: `CAST(julianday('now') - julianday(${DATE_PADDED('coalesce(e.first_release_date, ag.first_release_date)')}) AS INTEGER)`,
        sortable: true,
      },
      genre: { label: 'Genre', type: 'genre', sortable: false },
      ...CREDIT_FIELDS,
    },
    groups: {
      artist: { label: 'Artist', sql: RECORDING_PRIMARY_ARTIST('id') },
      album: { label: 'Album', sql: 'ra.release_group_id' },
      year: { label: 'Year', sql: 'substr(coalesce(e.first_release_date, ag.first_release_date), 1, 4)' },
    },
  },

  release_group: {
    label: 'Albums',
    from: `
      FROM release_group e
      LEFT JOIN v_release_score s ON s.release_group_id = e.id AND s.user_id = ${USER}`,
    ownCredit: `c.entity_type = 'release_group' AND c.entity_id = e.id`,
    deepCredit: `(
      (c.entity_type = 'release_group' AND c.entity_id = e.id)
      OR (c.entity_type = 'release' AND c.entity_id IN (SELECT id FROM release WHERE release_group_id = e.id))
      OR (c.entity_type = 'recording' AND c.entity_id IN (
            SELECT t.recording_id FROM track t
            JOIN v_release_group_canonical cc ON cc.release_id = t.release_id
            WHERE cc.release_group_id = e.id)))`,
    genre: `EXISTS (SELECT 1 FROM v_release_group_genre vg WHERE vg.release_group_id = e.id AND vg.genre_id IN ({genres}))`,
    fields: {
      title: { label: 'Title', type: 'text', sql: 'e.title', sortable: true },
      artist: {
        label: 'Artist',
        type: 'credit',
        sortable: true,
        sql: RELEASE_GROUP_PRIMARY_ARTIST('sort_name'),
        credit: { roles: ['primary', 'featured'], deep: false },
      },
      type: { label: 'Type', type: 'enum', sql: 'e.type', values: RELEASE_GROUP_TYPES, sortable: false },
      status: { label: 'Status', type: 'enum', sql: 'e.status', values: ['announced', 'released', 'cancelled'], sortable: false },
      availability: {
        label: 'Availability',
        type: 'enum',
        sql: 'e.availability',
        values: ['for_sale', 'unpurchasable', 'unreleased'],
        sortable: false,
      },
      first_release_date: { label: 'Released', type: 'date', sql: 'e.first_release_date', sortable: true },
      quality_score: { label: 'Quality score', type: 'number', sql: 's.quality_score', sortable: true },
      personal_score: { label: 'Personal score', type: 'number', sql: 's.personal_score', sortable: true },
      impact: { label: 'Impact', type: 'number', sql: '(s.personal_score - s.quality_score)', sortable: true },
      track_count: { label: 'Track count', type: 'number', sql: 's.track_count', sortable: true },
      rated_track_count: { label: 'Rated tracks', type: 'number', sql: 's.rated_track_count', sortable: true },
      coverage: {
        label: 'Share of tracks rated',
        type: 'number',
        sql: '(1.0 * s.rated_track_count / nullif(s.track_count, 0))',
        sortable: true,
        description: '0 to 1.',
      },
      owned: {
        label: 'Owned',
        type: 'boolean',
        sql: `EXISTS (SELECT 1 FROM holding h JOIN release r ON r.id = h.release_id
                      WHERE r.release_group_id = e.id AND h.user_id = ${USER})`,
        sortable: false,
      },
      play_count: {
        label: 'Play count',
        type: 'number',
        sql: `(SELECT count(*) FROM play p
               JOIN track t ON t.recording_id = p.recording_id
               JOIN v_release_group_canonical cc ON cc.release_id = t.release_id
               WHERE cc.release_group_id = e.id AND p.user_id = ${USER} AND p.counted = 1)`,
        sortable: true,
      },
      days_since_release: {
        label: 'Days since release',
        type: 'number',
        sql: `CAST(julianday('now') - julianday(${DATE_PADDED('e.first_release_date')}) AS INTEGER)`,
        sortable: true,
      },
      genre: { label: 'Genre', type: 'genre', sortable: false },
      ...CREDIT_FIELDS,
    },
    groups: {
      artist: { label: 'Artist', sql: RELEASE_GROUP_PRIMARY_ARTIST('id') },
      year: { label: 'Year', sql: 'substr(e.first_release_date, 1, 4)' },
      type: { label: 'Type', sql: 'e.type' },
    },
  },

  artist: {
    label: 'Artists',
    // Aggregates over the artist's own albums and tracks (primary credits).
    from: `
      FROM artist e
      LEFT JOIN (
        SELECT c.artist_id,
               count(*) AS album_count,
               count(rs.quality_score) AS rated_album_count,
               avg(rs.quality_score) AS avg_album_score
        FROM artist_credit c
        LEFT JOIN v_release_score rs ON rs.release_group_id = c.entity_id AND rs.user_id = ${USER}
        WHERE c.entity_type = 'release_group' AND c.role = 'primary'
        GROUP BY c.artist_id
      ) al ON al.artist_id = e.id
      LEFT JOIN (
        SELECT c.artist_id,
               count(*) AS rated_track_count,
               avg(ts.quality_score) AS avg_track_score,
               avg(ts.quality_score * ts.quality_score) - avg(ts.quality_score) * avg(ts.quality_score) AS track_variance
        FROM artist_credit c
        JOIN v_recording_score ts ON ts.recording_id = c.entity_id AND ts.user_id = ${USER}
        WHERE c.entity_type = 'recording' AND c.role = 'primary'
        GROUP BY c.artist_id
      ) tr ON tr.artist_id = e.id`,
    fields: {
      name: { label: 'Name', type: 'text', sql: 'e.name', sortable: true },
      album_count: { label: 'Albums', type: 'number', sql: 'coalesce(al.album_count, 0)', sortable: true },
      rated_album_count: { label: 'Rated albums', type: 'number', sql: 'coalesce(al.rated_album_count, 0)', sortable: true },
      avg_rating: { label: 'Average album score', type: 'number', sql: 'al.avg_album_score', sortable: true },
      rated_track_count: { label: 'Rated tracks', type: 'number', sql: 'coalesce(tr.rated_track_count, 0)', sortable: true },
      avg_track_rating: { label: 'Average track score', type: 'number', sql: 'tr.avg_track_score', sortable: true },
      rating_variance: {
        label: 'Track score variance',
        type: 'number',
        sql: 'tr.track_variance',
        sortable: true,
        description: 'Low means consistent.',
      },
      play_count: {
        label: 'Play count',
        type: 'number',
        sql: `(SELECT count(*) FROM play p
               JOIN artist_credit c ON c.entity_type = 'recording' AND c.entity_id = p.recording_id
               WHERE c.artist_id = e.id AND c.role = 'primary' AND p.user_id = ${USER} AND p.counted = 1)`,
        sortable: true,
      },
    },
    groups: {},
  },
};

export const DEFAULT_SORT: Record<Entity, { field: string; dir: 'asc' | 'desc' }[]> = {
  recording: [{ field: 'personal_score', dir: 'desc' }],
  release_group: [{ field: 'personal_score', dir: 'desc' }],
  artist: [{ field: 'avg_rating', dir: 'desc' }],
};
