/**
 * Saving listens from any source: the tracks first (matched to the
 * catalogue where it has them), then the plays, then the dedupe pass over
 * the stretch of time the plays cover (dedupe.ts has the rule).
 */

import { env } from 'cloudflare:workers';
import { dedupe, MIN_COUNTED_MS, type DedupePlay, type PlaySource } from './dedupe';
import type { ListenTrackRow } from './keys';
import { matchTrack, type CatalogueIndex } from './match';

export interface NewPlay {
  track_key: string;
  /** ISO, UTC, when listening started. */
  played_at: string;
  ms_played: number | null;
  skipped?: boolean | null;
  shuffle?: boolean | null;
  offline?: boolean | null;
  incognito?: boolean | null;
  platform?: string | null;
  country?: string | null;
  reason_start?: string | null;
  reason_end?: string | null;
}

/** Adds tracks not yet held, matching them to recordings; fills a match on ones held unmatched. Returns how many matched. */
export async function saveTracks(rows: ListenTrackRow[], index: CatalogueIndex): Promise<number> {
  if (rows.length === 0) return 0;
  const now = new Date().toISOString();
  let matched = 0;
  const withMatch = rows.map((row) => {
    const hit = matchTrack(index, { artist: row.artist, title: row.title, album: row.album, spotify_id: row.spotify_id, mbid: row.mbid });
    if (hit) matched += 1;
    return { ...row, recording_id: hit?.id ?? null, matched_at: hit ? now : null };
  });
  for (let i = 0; i < withMatch.length; i += 1000) {
    await env.DB.prepare(
      `INSERT INTO listen_track (key, artist, title, album, artist_key, title_key, spotify_id, mbid, recording_id, matched_at)
       SELECT j.value ->> '$.key', j.value ->> '$.artist', j.value ->> '$.title', j.value ->> '$.album',
              j.value ->> '$.artist_key', j.value ->> '$.title_key', j.value ->> '$.spotify_id', j.value ->> '$.mbid',
              (SELECT r.id FROM recording r WHERE r.id = j.value ->> '$.recording_id'), j.value ->> '$.matched_at'
       FROM json_each(?1) j
       WHERE true
       ON CONFLICT (key) DO UPDATE SET
         recording_id = coalesce(listen_track.recording_id, excluded.recording_id),
         matched_at = coalesce(listen_track.matched_at, excluded.matched_at),
         album = coalesce(listen_track.album, excluded.album)`,
    )
      .bind(JSON.stringify(withMatch.slice(i, i + 1000)))
      .run();
  }
  return matched;
}

const flag = (v: boolean | null | undefined) => (v == null ? null : v ? 1 : 0);

/** Adds plays (their tracks must be saved first), skipping any already held, then dedupes their stretch of time. Returns how many were new. */
export async function savePlays(userId: string, source: PlaySource, plays: NewPlay[]): Promise<number> {
  if (plays.length === 0) return 0;
  const rows = plays.map((p) => ({
    id: crypto.randomUUID(),
    track_key: p.track_key,
    played_at: p.played_at,
    ms_played: p.ms_played,
    counted: p.ms_played == null || p.ms_played >= MIN_COUNTED_MS ? 1 : 0,
    skipped: flag(p.skipped),
    shuffle: flag(p.shuffle),
    offline: flag(p.offline),
    incognito: flag(p.incognito),
    platform: p.platform?.slice(0, 100) ?? null,
    country: p.country?.slice(0, 8) ?? null,
    reason_start: p.reason_start?.slice(0, 40) ?? null,
    reason_end: p.reason_end?.slice(0, 40) ?? null,
  }));
  let added = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const result = await env.DB.prepare(
      `INSERT INTO play (id, user_id, track_key, recording_id, played_at, ms_played, source, counted,
                         skipped, shuffle, offline, incognito, platform, country, reason_start, reason_end)
       SELECT j.value ->> '$.id', ?1, t.key, t.recording_id, j.value ->> '$.played_at', j.value ->> '$.ms_played', ?2,
              j.value ->> '$.counted', j.value ->> '$.skipped', j.value ->> '$.shuffle', j.value ->> '$.offline',
              j.value ->> '$.incognito', j.value ->> '$.platform', j.value ->> '$.country',
              j.value ->> '$.reason_start', j.value ->> '$.reason_end'
       FROM json_each(?3) j
       JOIN listen_track t ON t.key = j.value ->> '$.track_key'
       WHERE true
       ON CONFLICT (user_id, track_key, played_at, source) DO NOTHING`,
    )
      .bind(userId, source, JSON.stringify(rows.slice(i, i + 1000)))
      .run();
    added += result.meta.changes ?? 0;
  }
  if (added > 0) {
    const times = plays.map((p) => p.played_at).sort();
    await dedupeSpan(userId, times[0]!, times.at(-1)!);
  }
  return added;
}

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Works out again which listens count between two times. Listens up to
 * six hours either side are read as context (a listen there can be the
 * other copy of one inside); only those within an hour of the stretch are
 * rewritten, as the decision for any further out may rest on listens
 * beyond what was read.
 */
export async function dedupeSpan(userId: string, from: string, to: string): Promise<number> {
  const start = Date.parse(from);
  const end = Date.parse(to);
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.source, p.played_at, p.ms_played, p.recording_id, p.counted, p.duplicate_of, t.artist_key, t.title_key
     FROM play p JOIN listen_track t ON t.key = p.track_key
     WHERE p.user_id = ?1 AND p.played_at >= ?2 AND p.played_at <= ?3`,
  )
    .bind(userId, iso(start - 6 * HOUR), iso(end + 6 * HOUR))
    .all<{ id: string; source: PlaySource; played_at: string; ms_played: number | null; recording_id: string | null; counted: number; duplicate_of: string | null; artist_key: string; title_key: string }>();
  const plays: DedupePlay[] = results.map((r) => ({ ...r, start: Date.parse(r.played_at) }));
  const before = new Map(results.map((r) => [r.id, r]));
  const startOf = new Map(plays.map((p) => [p.id, p.start]));
  const changes = dedupe(plays).filter((d) => {
    const at = startOf.get(d.id)!;
    if (at < start - HOUR || at > end + HOUR) return false;
    const was = before.get(d.id)!;
    return was.counted !== d.counted || was.duplicate_of !== d.duplicate_of;
  });
  const statements = changes.map((d) =>
    env.DB.prepare('UPDATE play SET counted = ?1, duplicate_of = ?2 WHERE id = ?3').bind(d.counted, d.duplicate_of, d.id),
  );
  for (let i = 0; i < statements.length; i += 200) await env.DB.batch(statements.slice(i, i + 200));
  return changes.length;
}

/**
 * Matches listened tracks that were not in the catalogue when heard, now
 * that it may have them, and points their plays at the recording. Nightly
 * and after imports. Returns how many matched.
 */
export async function rematchListens(index: CatalogueIndex, { limit = 5000 } = {}): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT key, artist, title, album, spotify_id, mbid FROM listen_track WHERE recording_id IS NULL ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(limit)
    .all<{ key: string; artist: string; title: string; album: string | null; spotify_id: string | null; mbid: string | null }>();
  const now = new Date().toISOString();
  const statements = [];
  for (const row of results) {
    const hit = matchTrack(index, row);
    if (!hit) continue;
    statements.push(
      env.DB.prepare('UPDATE listen_track SET recording_id = ?1, matched_at = ?2 WHERE key = ?3 AND recording_id IS NULL').bind(hit.id, now, row.key),
      env.DB.prepare('UPDATE play SET recording_id = ?1 WHERE track_key = ?2 AND recording_id IS NULL').bind(hit.id, row.key),
    );
  }
  for (let i = 0; i < statements.length; i += 200) await env.DB.batch(statements.slice(i, i + 200));
  return statements.length / 2;
}
