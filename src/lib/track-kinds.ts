/**
 * Track kinds (migration 0034): song, interlude or skit. A skit is not
 * rated and does not count; an interlude counts at the interlude weight;
 * a song is the default and is stored only when chosen, so an answered
 * suggestion is not asked again.
 *
 * Nothing is marked on its own. Suggestions are tracks that look like
 * interludes (short, or titled "Skit", "Interlude", "Intro"…) on albums in
 * the library, for Cillian to answer one at a time.
 */

import { env } from 'cloudflare:workers';
import type { TrackKind } from './scoring';

export const KINDS: TrackKind[] = ['song', 'interlude', 'skit'];
export const isKind = (value: unknown): value is TrackKind => KINDS.includes(value as TrackKind);

/** Cut-offs offered for "short", in seconds. */
export const CUTOFFS = [60, 90, 120] as const;
export const DEFAULT_CUTOFF = 90;

/** Titles that name a track's kind outright. */
const TITLE_HINT = /\b(skit|interlude|intro|outro|prelude|reprise|interval|segue)\b/i;
const SKIT_HINT = /\bskit\b/i;

export class TrackKindError extends Error {}

export async function setKind(recordingId: string, kind: TrackKind): Promise<void> {
  const exists = await env.DB.prepare(`SELECT 1 FROM recording WHERE id = ?`).bind(recordingId).first();
  if (!exists) throw new TrackKindError('That track is no longer in the library.');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO recording_kind (recording_id, kind) VALUES (?1, ?2)
       ON CONFLICT (recording_id) DO UPDATE SET kind = ?2, set_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ).bind(recordingId, kind),
    env.DB.prepare(`DELETE FROM recording_kind_skip WHERE recording_id = ?`).bind(recordingId),
  ]);
}

export async function skipSuggestion(recordingId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO recording_kind_skip (recording_id) VALUES (?1)
     ON CONFLICT (recording_id) DO UPDATE SET skipped_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  )
    .bind(recordingId)
    .run();
}

/** The kind of each of these recordings that is not a song. */
export async function kindsOf(ids: string[]): Promise<Map<string, TrackKind>> {
  if (ids.length === 0) return new Map();
  const { results } = await env.DB.prepare(
    `SELECT recording_id, kind FROM recording_kind WHERE kind <> 'song' AND recording_id IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(ids))
    .all<{ recording_id: string; kind: TrackKind }>();
  return new Map(results.map((r) => [r.recording_id, r.kind]));
}

export interface KindRow {
  id: string;
  title: string;
  length_ms: number | null;
  artist: string | null;
  album: string;
  album_id: string;
  art_key: string | null;
  rated: number;
  /** What the title or length suggests, for a suggestion; what it is, for a marked track. */
  kind: TrackKind;
  skipped: number;
}

const ROW = `
  r.id, r.title, r.length_ms,
  (SELECT group_concat(a.name, ', ') FROM artist_credit c JOIN artist a ON a.id = c.artist_id
   WHERE c.entity_type = 'recording' AND c.entity_id = r.id AND c.role = 'primary') AS artist,
  g.title AS album, g.id AS album_id, x.art_key,
  EXISTS (SELECT 1 FROM rating v WHERE v.entity_type = 'recording' AND v.entity_id = r.id) AS rated`;

/**
 * Tracks on the library's albums (their standard editions, live albums
 * aside) that look like interludes or skits and have not been answered:
 * shorter than the cut-off, or titled as one. Skipped ones come last.
 */
export async function suggestions(cutoffSeconds: number, limit = 40): Promise<{ rows: KindRow[]; total: number }> {
  const where = `
    FROM v_release_group_canonical c
    JOIN release x ON x.id = c.release_id
    JOIN release_group g ON g.id = c.release_group_id
    JOIN track t ON t.release_id = x.id
    JOIN recording r ON r.id = t.recording_id
    WHERE g.type <> 'live'
      AND NOT EXISTS (SELECT 1 FROM recording_kind k WHERE k.recording_id = r.id)
      AND (r.length_ms < ?1
           OR lower(r.title) GLOB '*skit*' OR lower(r.title) GLOB '*interlude*' OR lower(r.title) GLOB '*intro*'
           OR lower(r.title) GLOB '*outro*' OR lower(r.title) GLOB '*prelude*' OR lower(r.title) GLOB '*reprise*'
           OR lower(r.title) GLOB '*interval*' OR lower(r.title) GLOB '*segue*')`;
  const [rows, count] = await env.DB.batch([
    env.DB.prepare(
      `SELECT ${ROW}, s.skipped_at IS NOT NULL AS skipped
       ${where.replace('WHERE g.type', 'LEFT JOIN recording_kind_skip s ON s.recording_id = r.id WHERE g.type')}
       GROUP BY r.id
       ORDER BY skipped, s.skipped_at, rated DESC, g.title COLLATE NOCASE, t.disc, t.position
       LIMIT ?2`,
    ).bind(cutoffSeconds * 1000, limit),
    env.DB.prepare(`SELECT count(DISTINCT r.id) AS n ${where}`).bind(cutoffSeconds * 1000),
  ]);
  type Raw = Omit<KindRow, 'kind'>;
  const found = ((rows?.results ?? []) as Raw[])
    // GLOB matched "intro" inside "introspection"; the word test is stricter.
    .filter((r) => (r.length_ms != null && r.length_ms < cutoffSeconds * 1000) || TITLE_HINT.test(r.title))
    .map((r) => ({ ...r, kind: (SKIT_HINT.test(r.title) ? 'skit' : 'interlude') as TrackKind }));
  return { rows: found, total: (count?.results?.[0] as { n: number } | undefined)?.n ?? 0 };
}

/** Tracks already marked as interludes or skits, newest first. */
export async function markedTracks(): Promise<KindRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${ROW}, k.kind, 0 AS skipped
     FROM recording_kind k
     JOIN recording r ON r.id = k.recording_id
     LEFT JOIN track t ON t.recording_id = r.id
     LEFT JOIN release x ON x.id = t.release_id
     LEFT JOIN release_group g ON g.id = x.release_group_id
     WHERE k.kind <> 'song'
     GROUP BY r.id
     ORDER BY k.set_at DESC`,
  ).all<KindRow>();
  return results;
}
