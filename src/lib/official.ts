/**
 * Official releases only. MusicBrainz holds every bootleg, fan-made
 * "album" and unofficial mixtape anyone has entered, and its own site
 * hides them; imports now ask for that same view (browseArtistReleaseGroups),
 * and this checks what came in before it did.
 *
 * Checking is by artist: one request lists every release group MusicBrainz
 * counts as official for them, and their groups here that are missing from
 * it are marked unofficial. Groups no checked artist covers (Various
 * Artists, artists without a MusicBrainz id) are looked up one by one.
 *
 * Nothing is removed by the check. Cillian removes what he agrees with on
 * /manage/unofficial; a removal keeps a full snapshot of every row it took
 * (removed_release_group), and a discography import skips its MusicBrainz id.
 */

import { env } from 'cloudflare:workers';
import { browseArtistReleaseGroups, browseReleases } from './musicbrainz/client';

/** MusicBrainz's "Various Artists": browsing them would list half the catalogue. */
const VARIOUS_ARTISTS_MBID = '89ad4ac3-39f7-470e-963a-56509c546377';
/** How long an artist's check holds before it is done again. */
const RECHECK_DAYS = 90;

export class RemovalError extends Error {}

/**
 * Checks artists (then lone groups) against MusicBrainz until the budget
 * runs out. Returns how many lookups it made, so the caller knows whether
 * there is more to do.
 */
export async function checkOfficialReleases({ budgetMs }: { budgetMs: number }): Promise<number> {
  const stop = Date.now() + budgetMs;
  let lookups = 0;

  const { results: artists } = await env.DB.prepare(
    `SELECT a.id, a.mbid FROM artist a
     WHERE a.mbid IS NOT NULL AND a.mbid <> ?
       AND (a.releases_checked_at IS NULL OR a.releases_checked_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?))
       -- Worked out once (about 5,000 rows), not per artist (ten million).
       AND a.id IN (SELECT c.artist_id FROM artist_credit c JOIN release_group g ON g.id = c.entity_id
                    WHERE c.entity_type = 'release_group' AND c.role = 'primary' AND g.mbid IS NOT NULL)
     ORDER BY a.releases_checked_at IS NOT NULL, a.releases_checked_at
     LIMIT 60`,
  )
    .bind(VARIOUS_ARTISTS_MBID, `-${RECHECK_DAYS} days`)
    .all<{ id: string; mbid: string }>();

  for (const artist of artists) {
    if (Date.now() > stop) return lookups;
    const official = (await browseArtistReleaseGroups(artist.mbid)).map((g) => g.id);
    lookups++;
    await markArtistGroups(artist.id, official);
  }

  // Whatever no artist check reached.
  while (Date.now() < stop) {
    const group = await env.DB.prepare(
      `SELECT id, mbid FROM release_group WHERE official IS NULL AND mbid IS NOT NULL ORDER BY created_at LIMIT 1`,
    ).first<{ id: string; mbid: string }>();
    if (!group || artists.length > 0) break; // artists first: their checks settle most groups at once
    const releases = await browseReleases(group.mbid);
    lookups++;
    const isOfficial = releases.length === 0 || releases.some((r) => r.status === 'Official');
    await env.DB.prepare('UPDATE release_group SET official = ? WHERE id = ?').bind(isOfficial ? 1 : 0, group.id).run();
  }
  return lookups;
}

/**
 * Marks an artist's groups from MusicBrainz's official list. A group listed
 * is official; one missing is unofficial, unless another of its artists'
 * lists already showed it official (a collaboration filed under one name).
 */
export async function markArtistGroups(artistId: string, officialMbids: string[]): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE release_group
       SET official = CASE WHEN mbid IN (SELECT value FROM json_each(?1)) OR official = 1 THEN 1 ELSE 0 END
       WHERE mbid IS NOT NULL
         AND id IN (SELECT entity_id FROM artist_credit WHERE entity_type = 'release_group' AND role = 'primary' AND artist_id = ?2)`,
    ).bind(JSON.stringify(officialMbids), artistId),
    env.DB.prepare(`UPDATE artist SET releases_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).bind(artistId),
  ]);
}

export interface CheckProgress {
  checked: number;
  artists: number;
}

/** How far the check has got, by artist. */
export async function checkProgress(): Promise<CheckProgress> {
  const row = await env.DB.prepare(
    `SELECT count(*) AS artists, count(a.releases_checked_at) AS checked FROM artist a
     WHERE a.mbid IS NOT NULL AND a.mbid <> ?
       -- Worked out once (about 5,000 rows), not per artist (ten million).
       AND a.id IN (SELECT c.artist_id FROM artist_credit c JOIN release_group g ON g.id = c.entity_id
                    WHERE c.entity_type = 'release_group' AND c.role = 'primary' AND g.mbid IS NOT NULL)`,
  )
    .bind(VARIOUS_ARTISTS_MBID)
    .first<CheckProgress>();
  return row ?? { checked: 0, artists: 0 };
}

export interface UnofficialGroup {
  id: string;
  title: string;
  type: string;
  first_release_date: string | null;
  artist: string | null;
  art_key: string | null;
  /** Rated as an album, or owned: removing it waits on Cillian keeping or merging it. */
  blocked: string | null;
}

/** Groups found unofficial and not kept, newest first within each artist. */
export async function unofficialGroups(): Promise<UnofficialGroup[]> {
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.title, g.type, g.first_release_date,
       (SELECT group_concat(coalesce(c.credited_as, a.name) || c.join_phrase, '')
        FROM artist_credit c JOIN artist a ON a.id = c.artist_id
        WHERE c.entity_type = 'release_group' AND c.entity_id = g.id AND c.role = 'primary'
        ORDER BY c.position) AS artist,
       (SELECT r.art_key FROM release r WHERE r.release_group_id = g.id AND r.art_key IS NOT NULL LIMIT 1) AS art_key,
       CASE
         WHEN EXISTS (SELECT 1 FROM rating x WHERE x.entity_type = 'release_group' AND x.entity_id = g.id) THEN 'rated'
         WHEN EXISTS (SELECT 1 FROM holding h JOIN release r ON r.id = h.release_id WHERE r.release_group_id = g.id) THEN 'owned'
       END AS blocked
     FROM release_group g
     WHERE g.official = 0 AND g.keep_unofficial = 0
     ORDER BY artist COLLATE NOCASE, g.first_release_date DESC`,
  ).all<UnofficialGroup>();
  return results;
}

/** Keeps a group Cillian counts as real though MusicBrainz does not. */
export async function keepUnofficial(id: string): Promise<void> {
  await env.DB.prepare('UPDATE release_group SET keep_unofficial = 1 WHERE id = ?').bind(id).run();
}

/** MusicBrainz ids of removed albums, which a discography import skips. */
export async function removedMbids(mbids: string[]): Promise<Set<string>> {
  if (mbids.length === 0) return new Set();
  const { results } = await env.DB.prepare(
    `SELECT mbid FROM removed_release_group WHERE mbid IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(mbids))
    .all<{ mbid: string }>();
  return new Set(results.map((r) => r.mbid));
}

type Row = Record<string, unknown>;

/**
 * Removes an album and everything that is only its: its editions, their
 * tracks, recordings on no other release, and every credit, genre, edit,
 * review item and search entry pointing at them. All in one transaction,
 * after a snapshot of every row is written, so a missed reference fails the
 * whole removal rather than leaving half an album.
 *
 * Refused for an album that is rated or owned. A recording only it carries
 * stays (as a loose recording) when it is rated, played, on file, or pinned
 * in a playlist: those are Cillian's data, not MusicBrainz's.
 */
export async function removeReleaseGroup(id: string, reason: 'unofficial' | 'not_wanted'): Promise<void> {
  const group = await env.DB.prepare('SELECT * FROM release_group WHERE id = ?').bind(id).first<Row>();
  if (!group) throw new RemovalError('That album is not in the library.');
  const rated = await env.DB.prepare(`SELECT 1 FROM rating WHERE entity_type = 'release_group' AND entity_id = ? LIMIT 1`).bind(id).first();
  if (rated) throw new RemovalError(`“${group.title}” is rated, so it stays. Merge it into the real album instead.`);

  const releases = (await env.DB.prepare('SELECT * FROM release WHERE release_group_id = ?').bind(id).all<Row>()).results;
  const releaseIds = releases.map((r) => r.id as string);
  const owned = await env.DB.prepare(`SELECT 1 FROM holding WHERE release_id IN (SELECT value FROM json_each(?)) LIMIT 1`)
    .bind(JSON.stringify(releaseIds))
    .first();
  if (owned) throw new RemovalError(`You own a copy of “${group.title}”, so it stays.`);

  const tracks = (await env.DB.prepare(`SELECT * FROM track WHERE release_id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(releaseIds))
    .all<Row>()).results;
  // Recordings on no other release, and none of Cillian's own data on them.
  const recordings = (
    await env.DB.prepare(
      `SELECT r.* FROM recording r
       WHERE r.id IN (SELECT recording_id FROM track WHERE release_id IN (SELECT value FROM json_each(?1)))
         AND NOT EXISTS (SELECT 1 FROM track t WHERE t.recording_id = r.id AND t.release_id NOT IN (SELECT value FROM json_each(?1)))
         AND NOT EXISTS (SELECT 1 FROM rating x WHERE x.entity_type = 'recording' AND x.entity_id = r.id)
         AND NOT EXISTS (SELECT 1 FROM play p WHERE p.recording_id = r.id)
         AND NOT EXISTS (SELECT 1 FROM file f WHERE f.recording_id = r.id)
         AND NOT EXISTS (SELECT 1 FROM definition_pin d WHERE d.recording_id = r.id)
         AND NOT EXISTS (SELECT 1 FROM definition_exclude d WHERE d.recording_id = r.id)`,
    )
      .bind(JSON.stringify(releaseIds))
      .all<Row>()
  ).results;
  const recordingIds = recordings.map((r) => r.id as string);

  // Every entity going, by the type name the shared tables use.
  const gone: [string, string[]][] = [
    ['release_group', [id]],
    ['release', releaseIds],
    ['recording', recordingIds],
  ];
  const each = async (table: string) => {
    const rows: Row[] = [];
    for (const [type, ids] of gone) {
      if (ids.length === 0) continue;
      const found = await env.DB.prepare(`SELECT * FROM ${table} WHERE entity_type = ? AND entity_id IN (SELECT value FROM json_each(?))`)
        .bind(type, JSON.stringify(ids))
        .all<Row>();
      rows.push(...found.results);
    }
    return rows;
  };
  const snapshot = {
    release_group: group,
    release: releases,
    track: tracks,
    recording: recordings,
    artist_credit: await each('artist_credit'),
    genre_tag: await each('genre_tag'),
    field_override: await each('field_override'),
  };
  const artist = await env.DB.prepare(
    `SELECT group_concat(a.name, ', ') AS name FROM artist_credit c JOIN artist a ON a.id = c.artist_id
     WHERE c.entity_type = 'release_group' AND c.entity_id = ? AND c.role = 'primary'`,
  )
    .bind(id)
    .first<{ name: string | null }>();

  const all = JSON.stringify([id, ...releaseIds, ...recordingIds]);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO removed_release_group (id, mbid, title, artist, reason, snapshot_json) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(id, group.mbid ?? null, group.title, artist?.name ?? null, reason, JSON.stringify(snapshot)),
    env.DB.prepare('UPDATE release_group SET preferred_release_id = NULL WHERE id = ?').bind(id),
    env.DB.prepare(`UPDATE work SET preferred_recording_id = NULL WHERE preferred_recording_id IN (SELECT value FROM json_each(?))`).bind(
      JSON.stringify(recordingIds),
    ),
    env.DB.prepare(`DELETE FROM track WHERE release_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(releaseIds)),
  ];
  for (const [type, ids] of gone) {
    if (ids.length === 0) continue;
    const list = JSON.stringify(ids);
    for (const table of ['artist_credit', 'genre_tag', 'field_override', 'queue_handoff', 'queue_skip']) {
      statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE entity_type = ? AND entity_id IN (SELECT value FROM json_each(?))`).bind(type, list));
    }
    statements.push(
      env.DB.prepare(
        `DELETE FROM anomaly WHERE entity_type = ?1 AND (entity_a IN (SELECT value FROM json_each(?2)) OR entity_b IN (SELECT value FROM json_each(?2)))`,
      ).bind(type, list),
      env.DB.prepare(
        `DELETE FROM confirmed_distinct WHERE entity_type = ?1 AND (id_a IN (SELECT value FROM json_each(?2)) OR id_b IN (SELECT value FROM json_each(?2)))`,
      ).bind(type, list),
    );
  }
  statements.push(
    env.DB.prepare(`DELETE FROM lookup_log WHERE entity_id IN (SELECT value FROM json_each(?))`).bind(all),
    env.DB.prepare(`DELETE FROM search_index WHERE entity_id IN (SELECT value FROM json_each(?))`).bind(all),
    env.DB.prepare(`DELETE FROM recording WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(recordingIds)),
    env.DB.prepare('DELETE FROM release WHERE release_group_id = ?').bind(id),
    env.DB.prepare('DELETE FROM release_group WHERE id = ?').bind(id),
  );
  await env.DB.batch(statements);
}

/**
 * Removes unofficial groups that nothing holds back, until the budget runs
 * out (a request has only so many database calls). Returns how many went
 * and how many are left to go.
 */
export async function removeUnofficial({ budgetMs }: { budgetMs: number }): Promise<{ removed: number; left: number }> {
  const stop = Date.now() + budgetMs;
  const free = (await unofficialGroups()).filter((g) => !g.blocked);
  let removed = 0;
  for (const group of free) {
    if (Date.now() > stop || removed >= 40) break;
    await removeReleaseGroup(group.id, 'unofficial');
    removed++;
  }
  return { removed, left: free.length - removed };
}
