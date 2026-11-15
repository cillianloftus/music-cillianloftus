/**
 * Marking versions by hand, from a track's page: "this is a version of
 * that" (one song: they share a work, show as each other's versions, and
 * an unrated one borrows the rated one's score, inherited.ts), or "this is
 * the same recording" (merged, merge.ts). Before, the only way was the
 * Review queue, waiting for a rule to raise the pair.
 */

import { env } from 'cloudflare:workers';
import { mergeSame } from './merge';
import { rebuildAllInheritedScores } from './inherited';
import { splitVersion } from './versions';

export class VersionError extends Error {}

/** One song: both recordings (and every other recording of either's work) on one work. */
export async function markVersion(id: string, of: string): Promise<void> {
  if (id === of) throw new VersionError('A song cannot be a version of itself.');
  const { results } = await env.DB.prepare(`SELECT id, title, work_id FROM recording WHERE id IN (?1, ?2)`)
    .bind(id, of)
    .all<{ id: string; title: string; work_id: string | null }>();
  const mine = results.find((r) => r.id === id);
  const theirs = results.find((r) => r.id === of);
  if (!mine || !theirs) throw new VersionError('One of these songs is no longer in the library.');
  if (mine.work_id && mine.work_id === theirs.work_id) return;

  const statements: D1PreparedStatement[] = [];
  // The work they share: the one picked already has, else this one's, else a new one named for the one picked.
  let work = theirs.work_id ?? mine.work_id;
  if (!work) {
    work = crypto.randomUUID();
    statements.push(env.DB.prepare(`INSERT INTO work (id, title, source) VALUES (?, ?, 'manual')`).bind(work, theirs.title));
  }
  // Each recording, and any already on the other's work, to the one work.
  for (const r of [mine, theirs]) {
    if (r.work_id && r.work_id !== work) {
      statements.push(env.DB.prepare(`UPDATE recording SET work_id = ?1 WHERE work_id = ?2`).bind(work, r.work_id));
    } else if (!r.work_id) {
      statements.push(env.DB.prepare(`UPDATE recording SET work_id = ?1 WHERE id = ?2`).bind(work, r.id));
    }
  }
  // Raised in Review as a possible version of each other: answered.
  statements.push(
    env.DB.prepare(
      `UPDATE anomaly SET status = 'resolved', resolution = 'linked_work'
       WHERE status = 'open' AND entity_type = 'recording' AND ((entity_a = ?1 AND entity_b = ?2) OR (entity_a = ?2 AND entity_b = ?1))`,
    ).bind(id, of),
  );
  await env.DB.batch(statements);
  await shareScores();
}

/** The same recording entered twice: merged, the one holding more kept. Returns the one kept. */
export async function markSame(id: string, of: string): Promise<string> {
  if (id === of) throw new VersionError('A song cannot be merged with itself.');
  const kept = await mergeSame('recording', id, of);
  await shareScores();
  return kept;
}

/** Versions borrow scores across the new link at once, and album scores follow. */
async function shareScores(): Promise<void> {
  await rebuildAllInheritedScores();
  await env.DB.prepare(`UPDATE app_setting SET value = CAST(value AS INTEGER) + 1 WHERE key = 'scores_version'`).run();
}

export interface VersionCandidate {
  id: string;
  title: string;
  album_title: string | null;
  year: string | null;
}

/**
 * Likely versions of a song not yet linked to it: its artist's songs with
 * the same song once version words are set aside ("Song (Remix)", "Song -
 * Live"), best first. One seek of the artist's credits, matched here.
 */
export async function versionCandidates(id: string, limit = 6): Promise<VersionCandidate[]> {
  const me = await env.DB.prepare(
    `SELECT r.title, r.work_id,
            (SELECT c.artist_id FROM artist_credit c WHERE c.entity_type = 'recording' AND c.entity_id = r.id AND c.role = 'primary' ORDER BY c.position LIMIT 1) AS artist
     FROM recording r WHERE r.id = ?`,
  )
    .bind(id)
    .first<{ title: string; work_id: string | null; artist: string | null }>();
  if (!me?.artist) return [];
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.title, r.work_id, substr(r.first_release_date, 1, 4) AS year
     FROM artist_credit c JOIN recording r ON r.id = c.entity_id
     WHERE c.entity_type = 'recording' AND c.artist_id = ? AND c.role = 'primary' AND r.id <> ?`,
  )
    .bind(me.artist, id)
    .all<{ id: string; title: string; work_id: string | null; year: string | null }>();
  const song = splitVersion(me.title).song;
  const picked = results
    .filter((r) => splitVersion(r.title).song === song && !(me.work_id && r.work_id === me.work_id))
    .sort((a, b) => (a.year ?? '9999').localeCompare(b.year ?? '9999'))
    .slice(0, limit);
  if (picked.length === 0) return [];
  // Albums only for those offered: looked up for every song of a big artist's, 5,500 rows a page.
  const { results: albums } = await env.DB.prepare(
    `SELECT j.value AS id,
            (SELECT g.title FROM track t JOIN release x ON x.id = t.release_id JOIN release_group g ON g.id = x.release_group_id
             WHERE t.recording_id = j.value ORDER BY g.first_release_date LIMIT 1) AS album_title
     FROM json_each(?) j`,
  )
    .bind(JSON.stringify(picked.map((r) => r.id)))
    .all<{ id: string; album_title: string | null }>();
  const albumOf = new Map(albums.map((a) => [a.id, a.album_title]));
  return picked.map((r) => ({ id: r.id, title: r.title, year: r.year, album_title: albumOf.get(r.id) ?? null }));
}
