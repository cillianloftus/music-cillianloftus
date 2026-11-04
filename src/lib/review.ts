/**
 * The review queue (ARCHITECTURE.md §3, "Review queue"). Rules look for
 * things that are probably wrong and raise anomalies. They never fix
 * anything themselves: every change here starts from a person choosing a
 * resolution.
 *
 * A pair judged distinct goes into confirmed_distinct, and a dismissed
 * single-entity anomaly stays dismissed, so nothing is raised twice. An
 * open anomaly whose rule no longer fires closes itself.
 */

import { env } from 'cloudflare:workers';
import { normaliseName, normaliseTitle } from './text';

export type AnomalyKind =
  | 'duplicate_artist_name'
  | 'near_duplicate_recording'
  | 'near_duplicate_release_group'
  | 'track_count_mismatch'
  | 'unlinked_rated_recording'
  | 'missing_cover_art'
  | 'orphaned_track';

type EntityType = 'artist' | 'recording' | 'release_group';

export interface Finding {
  kind: AnomalyKind;
  entity_type: EntityType;
  entity_a: string;
  entity_b: string | null;
}

/** Thresholds are current preferences, not structure. */
export const REVIEW_RULES = {
  /** A group's largest release has at least this many times the tracks of its smallest… */
  trackCountRatio: 2,
  /** …and at least this many more, so a 2-track single beside a 4-track one is fine. */
  trackCountGap: 4,
} as const;

const pair = (kind: AnomalyKind, entity_type: EntityType, x: string, y: string): Finding => {
  const [a, b] = x < y ? [x, y] : [y, x];
  return { kind, entity_type, entity_a: a, entity_b: b };
};

/** Every pair within each group of more than one. */
function pairsWithin<T>(groups: Map<string, T[]>, toFinding: (x: T, y: T) => Finding | null): Finding[] {
  const out: Finding[] = [];
  for (const members of groups.values()) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const finding = toFinding(members[i]!, members[j]!);
        if (finding) out.push(finding);
      }
    }
  }
  return out;
}

function groupBy<T>(rows: T[], key: (row: T) => string | null): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (k === null || k === '') continue;
    const list = groups.get(k);
    if (list) list.push(row);
    else groups.set(k, [row]);
  }
  return groups;
}

/** Runs every rule over the whole catalogue. Reads only. */
export async function findAnomalies(): Promise<Finding[]> {
  const [artists, recordings, groups, counts, unlinked, noArt, orphans] = await env.DB.batch([
    env.DB.prepare(`SELECT id, name FROM artist`),
    env.DB.prepare(
      `SELECT r.id, r.title, r.work_id, c.artist_id
       FROM recording r
       JOIN artist_credit c ON c.entity_type = 'recording' AND c.entity_id = r.id AND c.role = 'primary'`,
    ),
    env.DB.prepare(
      `SELECT g.id, g.title, g.type, c.artist_id
       FROM release_group g
       JOIN artist_credit c ON c.entity_type = 'release_group' AND c.entity_id = g.id AND c.role = 'primary'`,
    ),
    env.DB.prepare(
      `WITH sizes AS (
         SELECT r.release_group_id, count(t.id) AS n
         FROM release r LEFT JOIN track t ON t.release_id = r.id
         GROUP BY r.id
       )
       SELECT release_group_id FROM sizes
       GROUP BY release_group_id
       HAVING count(*) >= 2 AND min(n) > 0
          AND max(n) >= ?1 * min(n) AND max(n) - min(n) >= ?2`,
    ).bind(REVIEW_RULES.trackCountRatio, REVIEW_RULES.trackCountGap),
    env.DB.prepare(
      `SELECT DISTINCT r.id FROM recording r
       JOIN rating x ON x.entity_type = 'recording' AND x.entity_id = r.id
       WHERE r.work_id IS NULL`,
    ),
    env.DB.prepare(
      `SELECT c.release_group_id AS id FROM v_release_group_canonical c
       JOIN release r ON r.id = c.release_id
       WHERE r.art_key IS NULL`,
    ),
    env.DB.prepare(`SELECT r.id FROM recording r WHERE NOT EXISTS (SELECT 1 FROM track t WHERE t.recording_id = r.id)`),
  ]);
  const rows = <T>(result: D1Result | undefined) => (result?.results ?? []) as T[];

  const findings: Finding[] = [];

  // Two artists with the same name: often one typed by hand, one imported.
  findings.push(
    ...pairsWithin(
      groupBy(rows<{ id: string; name: string }>(artists), (a) => normaliseName(a.name)),
      (x, y) => pair('duplicate_artist_name', 'artist', x.id, y.id),
    ),
  );

  // Same artist, same title, not linked to the same work: two records of one song,
  // or two versions that should share a work so they collapse.
  type Rec = { id: string; title: string; work_id: string | null; artist_id: string };
  findings.push(
    ...pairsWithin(
      groupBy(rows<Rec>(recordings), (r) => `${r.artist_id}\u0000${normaliseTitle(r.title)}`),
      (x, y) => (x.id === y.id || (x.work_id !== null && x.work_id === y.work_id) ? null : pair('near_duplicate_recording', 'recording', x.id, y.id)),
    ),
  );

  // Same artist, same title once edition words go: usually a deluxe edition
  // imported as an album of its own.
  type Group = { id: string; title: string; type: string; artist_id: string };
  findings.push(
    ...pairsWithin(
      groupBy(rows<Group>(groups), (g) => `${g.artist_id}\u0000${normaliseTitle(g.title)}`),
      (x, y) => (x.id === y.id ? null : pair('near_duplicate_release_group', 'release_group', x.id, y.id)),
    ),
  );

  const single = (kind: AnomalyKind, entity_type: EntityType) => (r: { id?: string; release_group_id?: string }) =>
    ({ kind, entity_type, entity_a: (r.id ?? r.release_group_id)!, entity_b: null }) satisfies Finding;
  findings.push(...rows<{ release_group_id: string }>(counts).map(single('track_count_mismatch', 'release_group')));
  findings.push(...rows<{ id: string }>(unlinked).map(single('unlinked_rated_recording', 'recording')));
  findings.push(...rows<{ id: string }>(noArt).map(single('missing_cover_art', 'release_group')));
  findings.push(...rows<{ id: string }>(orphans).map(single('orphaned_track', 'recording')));

  // An artist credited twice on one recording would pair a row with itself.
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.kind}|${f.entity_a}|${f.entity_b ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Raises what the rules find, skipping anything already judged, and closes
 * open anomalies that no longer fire. One transaction.
 */
export async function detectAnomalies(): Promise<{ open: number; raised: number; cleared: number }> {
  const findings = (await findAnomalies()).map((f) => ({ ...f, id: crypto.randomUUID() }));
  const openIds = async () =>
    new Set(
      (await env.DB.prepare(`SELECT id FROM anomaly WHERE status = 'open'`).all<{ id: string }>()).results.map((r) => r.id),
    );
  const before = await openIds();

  const found = `SELECT json_extract(value, '$.id') AS id,
                        json_extract(value, '$.kind') AS kind,
                        json_extract(value, '$.entity_type') AS entity_type,
                        json_extract(value, '$.entity_a') AS entity_a,
                        json_extract(value, '$.entity_b') AS entity_b
                 FROM json_each(?1)`;
  await env.DB.batch([
    // OR IGNORE: one already open is left as it is (anomaly_open_once).
    env.DB.prepare(
      `INSERT OR IGNORE INTO anomaly (id, kind, entity_type, entity_a, entity_b)
       SELECT f.id, f.kind, f.entity_type, f.entity_a, f.entity_b
       FROM (${found}) f
       WHERE NOT EXISTS (SELECT 1 FROM confirmed_distinct d
                         WHERE d.entity_type = f.entity_type AND d.id_a = f.entity_a AND d.id_b = f.entity_b)
         AND NOT EXISTS (SELECT 1 FROM anomaly x
                         WHERE x.kind = f.kind AND x.entity_a = f.entity_a
                           AND coalesce(x.entity_b, '') = coalesce(f.entity_b, '')
                           AND x.status = 'dismissed')`,
    ).bind(JSON.stringify(findings)),
    env.DB.prepare(
      `UPDATE anomaly SET status = 'resolved', resolution = 'cleared'
       WHERE status = 'open'
         AND NOT EXISTS (SELECT 1 FROM (${found}) f
                         WHERE f.kind = anomaly.kind AND f.entity_a = anomaly.entity_a
                           AND coalesce(f.entity_b, '') = coalesce(anomaly.entity_b, ''))`,
    ).bind(JSON.stringify(findings)),
  ]);

  const after = await openIds();
  return {
    open: after.size,
    raised: [...after].filter((id) => !before.has(id)).length,
    cleared: [...before].filter((id) => !after.has(id)).length,
  };
}

export interface Anomaly extends Finding {
  id: string;
  detected_at: string;
  status: 'open' | 'resolved' | 'dismissed';
  resolution: string | null;
}

export async function openAnomalies(): Promise<Anomaly[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, entity_type, entity_a, entity_b, detected_at, status, resolution
     FROM anomaly WHERE status = 'open' ORDER BY kind, detected_at, id`,
  ).all<Anomaly>();
  return results;
}

async function anomaly(id: string): Promise<Anomaly | null> {
  return env.DB.prepare(
    `SELECT id, kind, entity_type, entity_a, entity_b, detected_at, status, resolution FROM anomaly WHERE id = ?`,
  )
    .bind(id)
    .first<Anomaly>();
}

export class ReviewError extends Error {}

/**
 * Not a problem. A pair goes into confirmed_distinct; either way this
 * anomaly is never raised again.
 */
export async function dismiss(id: string): Promise<void> {
  const a = await anomaly(id);
  if (!a || a.status !== 'open') throw new ReviewError('That item is no longer open.');
  const statements = [
    env.DB.prepare(`UPDATE anomaly SET status = 'dismissed', resolution = ? WHERE id = ?`).bind(
      a.entity_b ? 'distinct' : 'expected',
      id,
    ),
  ];
  if (a.entity_b) {
    statements.push(
      env.DB.prepare(`INSERT OR IGNORE INTO confirmed_distinct (entity_type, id_a, id_b) VALUES (?, ?, ?)`).bind(
        a.entity_type,
        a.entity_a,
        a.entity_b,
      ),
    );
  }
  await env.DB.batch(statements);
}

/**
 * Links recordings to one work, so they collapse into one song in
 * playlists. Uses the work one of them already has, or creates one. Only
 * recordings with no work are changed: moving a recording between works
 * is a work merge, which is not this.
 */
export async function linkWork(id: string): Promise<string> {
  const a = await anomaly(id);
  if (!a || a.status !== 'open') throw new ReviewError('That item is no longer open.');
  if (a.kind !== 'near_duplicate_recording' && a.kind !== 'unlinked_rated_recording') {
    throw new ReviewError('Only recordings can be linked to a work.');
  }
  const ids = [a.entity_a, a.entity_b].filter((x): x is string => x !== null);
  const { results } = await env.DB.prepare(
    `SELECT id, title, work_id FROM recording WHERE id IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(ids))
    .all<{ id: string; title: string; work_id: string | null }>();
  if (results.length !== ids.length) throw new ReviewError('A recording in this item no longer exists.');

  const works = [...new Set(results.map((r) => r.work_id).filter((w): w is string => w !== null))];
  if (works.length > 1) throw new ReviewError('These recordings already belong to different works.');

  const statements = [];
  let workId = works[0];
  if (!workId) {
    workId = crypto.randomUUID();
    const title = results.find((r) => r.id === a.entity_a)!.title;
    statements.push(env.DB.prepare(`INSERT INTO work (id, title, source) VALUES (?, ?, 'manual')`).bind(workId, title));
  }
  statements.push(
    env.DB.prepare(`UPDATE recording SET work_id = ? WHERE id IN (SELECT value FROM json_each(?)) AND work_id IS NULL`).bind(
      workId,
      JSON.stringify(ids),
    ),
    env.DB.prepare(`UPDATE anomaly SET status = 'resolved', resolution = 'linked_work' WHERE id = ?`).bind(id),
  );
  await env.DB.batch(statements);
  return workId;
}

export interface ReviewEntity {
  id: string;
  title: string;
  href: string | null;
  /** Artist line, album or edition sizes: what tells two lookalikes apart. */
  detail: string;
  source: string;
  mbid: string | null;
}

/**
 * Names and context for every entity in a set of anomalies, keyed by id,
 * so the queue reads as sentences rather than ids.
 */
export async function reviewEntities(anomalies: Anomaly[]): Promise<Map<string, ReviewEntity>> {
  const ids = (type: EntityType) =>
    JSON.stringify([...new Set(anomalies.filter((a) => a.entity_type === type).flatMap((a) => [a.entity_a, a.entity_b]).filter(Boolean))]);

  const [artists, recordings, groups] = await env.DB.batch([
    env.DB.prepare(
      `SELECT a.id, a.name AS title, a.source, a.mbid, a.disambiguation,
              (SELECT count(*) FROM artist_credit c WHERE c.artist_id = a.id) AS credits
       FROM artist a WHERE a.id IN (SELECT value FROM json_each(?))`,
    ).bind(ids('artist')),
    env.DB.prepare(
      `SELECT r.id, r.title, r.source, r.mbid, r.length_ms,
              (SELECT group_concat(a.name, ', ') FROM artist_credit c JOIN artist a ON a.id = c.artist_id
               WHERE c.entity_type = 'recording' AND c.entity_id = r.id AND c.role = 'primary') AS artists,
              (SELECT group_concat(title, ', ') FROM (
                 SELECT DISTINCT g.title FROM track t JOIN release x ON x.id = t.release_id
                 JOIN release_group g ON g.id = x.release_group_id WHERE t.recording_id = r.id)) AS albums,
              (SELECT g.id FROM track t JOIN release x ON x.id = t.release_id
               JOIN release_group g ON g.id = x.release_group_id WHERE t.recording_id = r.id LIMIT 1) AS album_id
       FROM recording r WHERE r.id IN (SELECT value FROM json_each(?))`,
    ).bind(ids('recording')),
    env.DB.prepare(
      `SELECT g.id, g.title, g.source, g.mbid,
              (SELECT group_concat(a.name, ', ') FROM artist_credit c JOIN artist a ON a.id = c.artist_id
               WHERE c.entity_type = 'release_group' AND c.entity_id = g.id AND c.role = 'primary') AS artists,
              (SELECT group_concat(n, ' · ') FROM (
                 SELECT x.title || ': ' || count(t.id) || ' tracks' AS n
                 FROM release x LEFT JOIN track t ON t.release_id = x.id
                 WHERE x.release_group_id = g.id GROUP BY x.id ORDER BY count(t.id))) AS editions
       FROM release_group g WHERE g.id IN (SELECT value FROM json_each(?))`,
    ).bind(ids('release_group')),
  ]);

  const map = new Map<string, ReviewEntity>();
  type Row = Record<string, string | number | null>;
  const text = (v: unknown) => (v == null ? '' : String(v));
  for (const r of (artists?.results ?? []) as Row[]) {
    const credits = Number(r.credits);
    map.set(text(r.id), {
      id: text(r.id),
      title: text(r.title),
      href: `/artist/${r.id}`,
      detail: [r.disambiguation, `${credits} ${credits === 1 ? 'credit' : 'credits'}`].filter(Boolean).join(' · '),
      source: text(r.source),
      mbid: (r.mbid as string | null) ?? null,
    });
  }
  for (const r of (recordings?.results ?? []) as Row[]) {
    map.set(text(r.id), {
      id: text(r.id),
      title: text(r.title),
      href: r.album_id ? `/album/${r.album_id}` : null,
      detail: [r.artists, r.albums ? `on ${r.albums}` : 'on no release'].filter(Boolean).join(' · '),
      source: text(r.source),
      mbid: (r.mbid as string | null) ?? null,
    });
  }
  for (const r of (groups?.results ?? []) as Row[]) {
    map.set(text(r.id), {
      id: text(r.id),
      title: text(r.title),
      href: `/album/${r.id}`,
      detail: [r.artists, r.editions].filter(Boolean).join(' · '),
      source: text(r.source),
      mbid: (r.mbid as string | null) ?? null,
    });
  }
  return map;
}
