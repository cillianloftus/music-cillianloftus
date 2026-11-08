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
import { splitVersion, versionPairs } from './versions';

export type AnomalyKind =
  | 'duplicate_artist_name'
  | 'near_duplicate_recording'
  | 'near_duplicate_release_group'
  | 'version_of_recording'
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
  /** Two takes of a title further apart than this are versions, not duplicates. */
  lengthGapMs: 10_000,
  /** Lengths this close are the same recording: "Merge all that match" takes these. */
  sameLengthMs: 2_000,
} as const;

/** Titles many different tracks share, which say nothing about being one song. */
const GENERIC_TITLE =
  /^(intro|outro|interlude|skit|freestyle|untitled|prelude|reprise|instrumental|hidden track|bonus track|outro skit|intro skit)( \d+)?$/;

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
  const [artists, recordings, groups, counts, noArt, orphans] = await env.DB.batch([
    env.DB.prepare(`SELECT id, name FROM artist`),
    env.DB.prepare(
      // studio: on at least one release that is neither live nor unofficial.
      `SELECT r.id, r.title, r.work_id, r.length_ms, c.artist_id,
              EXISTS (SELECT 1 FROM track t JOIN release x ON x.id = t.release_id JOIN release_group g ON g.id = x.release_group_id
                      WHERE t.recording_id = r.id AND g.type <> 'live' AND coalesce(g.official, 1) = 1) AS studio
       FROM recording r
       JOIN artist_credit c ON c.entity_type = 'recording' AND c.entity_id = r.id AND c.role = 'primary'`,
    ),
    env.DB.prepare(
      `SELECT g.id, g.title, g.type, c.artist_id
       FROM release_group g
       JOIN artist_credit c ON c.entity_type = 'release_group' AND c.entity_id = g.id AND c.role = 'primary'
       WHERE coalesce(g.official, 1) = 1`,
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

  // Same artist, same title, about the same length: two records of one
  // song (the single's and the album's, a hand entry beside an import).
  // Not raised: a live or bootleg take (only on live or unofficial releases),
  // a length more than REVIEW_RULES.lengthGapMs apart (another version), a
  // generic title ("Intro", "Freestyle") that many different tracks share,
  // or a pair already linked as one song.
  type Rec = { id: string; title: string; work_id: string | null; length_ms: number | null; artist_id: string; studio: number };
  const candidates = rows<Rec>(recordings).filter((r) => r.studio && !GENERIC_TITLE.test(normaliseTitle(r.title)));
  findings.push(
    ...pairsWithin(groupBy(candidates, (r) => `${r.artist_id}\u0000${normaliseTitle(r.title)}`), (x, y) =>
      x.id === y.id ||
      (x.work_id !== null && x.work_id === y.work_id) ||
      (x.length_ms !== null && y.length_ms !== null && Math.abs(x.length_ms - y.length_ms) > REVIEW_RULES.lengthGapMs)
        ? null
        : pair('near_duplicate_recording', 'recording', x.id, y.id),
    ),
  );

  // A remix, sped-up, acoustic or live take beside the song itself, by the
  // same artist and not yet linked: "Link as a version" puts both in one
  // work. Ordered: the original first, then the version.
  for (const [original, version] of versionPairs(rows<Rec>(recordings), GENERIC_TITLE)) {
    findings.push({ kind: 'version_of_recording', entity_type: 'recording', entity_a: original, entity_b: version });
  }

  // Same artist, same title once edition words go: usually a deluxe edition
  // imported as an album of its own.
  type Group = { id: string; title: string; type: string; artist_id: string };
  findings.push(
    ...pairsWithin(
      groupBy(rows<Group>(groups), (g) => `${g.artist_id}\u0000${normaliseTitle(g.title)}`),
      (x, y) => (x.id === y.id ? null : pair('near_duplicate_release_group', 'release_group', x.id, y.id)),
    ),
  );
  // "Title: Subtitle" or "Title - Subtitle" beside plain "Title", by the
  // same artist: "Opening Night: The Complete Score" and "Opening Night".
  const head = (title: string) => {
    const m = /^(.+?)\s*(?::|\s[-–—]\s)\s*\S/u.exec(title);
    return m ? normaliseTitle(m[1]!) : null;
  };
  const groupRows = rows<Group>(groups);
  for (const x of groupRows) {
    const h = head(x.title);
    if (!h) continue;
    for (const y of groupRows) {
      if (y.id !== x.id && y.artist_id === x.artist_id && normaliseTitle(y.title) === h) {
        findings.push(pair('near_duplicate_release_group', 'release_group', x.id, y.id));
      }
    }
  }

  const single = (kind: AnomalyKind, entity_type: EntityType) => (r: { id?: string; release_group_id?: string }) =>
    ({ kind, entity_type, entity_a: (r.id ?? r.release_group_id)!, entity_b: null }) satisfies Finding;
  findings.push(...rows<{ release_group_id: string }>(counts).map(single('track_count_mismatch', 'release_group')));
  // A rated song with no work of its own is no longer raised: a song with
  // no work is already its own song everywhere, and its versions are found
  // by the version rule above. Open ones clear on the next run.
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

/** Statements of at most this many ids or findings, so each stays well inside D1's limits. */
const WRITE_CHUNK = 200;

/**
 * Raises what the rules find, skipping anything already judged, and closes
 * open anomalies that no longer fire.
 *
 * The comparison happens here rather than in SQL: the existing anomalies
 * and judged pairs are read once, and only what changed is written. Done
 * in SQL it was a scan per finding (about 8 million rows for a library of
 * a few thousand albums), which D1 refuses as overload. It runs after
 * every import, so it has to stay linear.
 */
export async function detectAnomalies(): Promise<{ open: number; raised: number; cleared: number }> {
  const findings = await findAnomalies();
  const [existing, distinct] = await env.DB.batch([
    env.DB.prepare(`SELECT id, kind, entity_a, entity_b, status FROM anomaly WHERE status IN ('open', 'dismissed')`),
    env.DB.prepare(`SELECT entity_type, id_a, id_b FROM confirmed_distinct`),
  ]);
  const key = (kind: string, a: string, b: string | null) => `${kind}\u0000${a}\u0000${b ?? ''}`;
  const open = new Map<string, string>();
  const dismissed = new Set<string>();
  for (const row of (existing?.results ?? []) as Array<{ id: string; kind: string; entity_a: string; entity_b: string | null; status: string }>) {
    if (row.status === 'open') open.set(key(row.kind, row.entity_a, row.entity_b), row.id);
    else dismissed.add(key(row.kind, row.entity_a, row.entity_b));
  }
  const judged = new Set(
    ((distinct?.results ?? []) as Array<{ entity_type: string; id_a: string; id_b: string }>).map((d) => `${d.entity_type}\u0000${d.id_a}\u0000${d.id_b}`),
  );

  const firing = new Set<string>();
  const raise: Array<Finding & { id: string }> = [];
  for (const f of findings) {
    const k = key(f.kind, f.entity_a, f.entity_b);
    firing.add(k);
    if (open.has(k) || dismissed.has(k)) continue;
    // Judged pairs are kept in id order; a version pair is raised original first.
    if (f.entity_b !== null) {
      const [x, y] = f.entity_a < f.entity_b ? [f.entity_a, f.entity_b] : [f.entity_b, f.entity_a];
      if (judged.has(`${f.entity_type}\u0000${x}\u0000${y}`)) continue;
    }
    raise.push({ ...f, id: crypto.randomUUID() });
  }
  const clear = [...open].filter(([k]) => !firing.has(k)).map(([, id]) => id);

  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < raise.length; i += WRITE_CHUNK) {
    statements.push(
      env.DB.prepare(
        // OR IGNORE: anomaly_open_once still guards against a run alongside this one.
        `INSERT OR IGNORE INTO anomaly (id, kind, entity_type, entity_a, entity_b)
         SELECT json_extract(value, '$.id'), json_extract(value, '$.kind'), json_extract(value, '$.entity_type'),
                json_extract(value, '$.entity_a'), json_extract(value, '$.entity_b')
         FROM json_each(?1)`,
      ).bind(JSON.stringify(raise.slice(i, i + WRITE_CHUNK))),
    );
  }
  for (let i = 0; i < clear.length; i += WRITE_CHUNK) {
    statements.push(
      env.DB.prepare(
        `UPDATE anomaly SET status = 'resolved', resolution = 'cleared'
         WHERE status = 'open' AND id IN (SELECT value FROM json_each(?1))`,
      ).bind(JSON.stringify(clear.slice(i, i + WRITE_CHUNK))),
    );
  }
  if (statements.length > 0) await env.DB.batch(statements);

  const now = await env.DB.prepare(`SELECT count(*) AS n FROM anomaly WHERE status = 'open'`).first<{ n: number }>();
  const opened = now?.n ?? 0;
  return { open: opened, raised: opened - (open.size - clear.length), cleared: clear.length };
}

export interface Anomaly extends Finding {
  id: string;
  detected_at: string;
  status: 'open' | 'resolved' | 'dismissed';
  resolution: string | null;
  skipped_at?: string | null;
}

/**
 * Open items, skipped ones last (longest-skipped first among them).
 * With a kind, only that kind, a page at a time.
 */
export async function openAnomalies(kind?: AnomalyKind, limit = 10_000, offset = 0): Promise<Anomaly[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, entity_type, entity_a, entity_b, detected_at, status, resolution, skipped_at
     FROM anomaly WHERE status = 'open' AND (?1 IS NULL OR kind = ?1)
     ORDER BY kind, skipped_at IS NOT NULL, skipped_at, detected_at, id
     LIMIT ?2 OFFSET ?3`,
  )
    .bind(kind ?? null, limit, offset)
    .all<Anomaly>();
  return results;
}

/** How many are open of each kind, and how many of those are skipped. */
export async function openCounts(): Promise<Map<AnomalyKind, { open: number; skipped: number }>> {
  const { results } = await env.DB.prepare(
    `SELECT kind, count(*) AS open, count(skipped_at) AS skipped FROM anomaly WHERE status = 'open' GROUP BY kind`,
  ).all<{ kind: AnomalyKind; open: number; skipped: number }>();
  return new Map(results.map((r) => [r.kind, { open: r.open, skipped: r.skipped }]));
}

/** Not now: to the back of its list, to come round again. */
export async function skip(id: string): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE anomaly SET skipped_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'open'`,
  )
    .bind(id)
    .run();
  if (!result.meta.changes) throw new ReviewError('That item is no longer open.');
}

/** "Same": merges the pair, keeping whichever holds more (merge.ts, survivor). */
export async function same(id: string): Promise<void> {
  const a = await anomaly(id);
  if (!a || a.status !== 'open' || !a.entity_b) throw new ReviewError('That item is no longer open.');
  const { mergeSame } = await import('./merge');
  await mergeSame(a.entity_type, a.entity_a, a.entity_b);
}

/**
 * Merges every open pair of duplicate tracks whose lengths agree to within
 * REVIEW_RULES.sameLengthMs, until the budget runs out. Returns how many
 * were merged and how many such pairs are left.
 */
export async function mergeMatchingTracks({ budgetMs }: { budgetMs: number }): Promise<{ merged: number; left: number }> {
  const stop = Date.now() + budgetMs;
  const pairs = await matchingTrackPairs();
  let merged = 0;
  const { mergeSame } = await import('./merge');
  for (const p of pairs) {
    if (Date.now() > stop || merged >= 40) break;
    // An earlier merge in this run may have taken one side already.
    const still = await env.DB.prepare(`SELECT 1 FROM anomaly WHERE id = ? AND status = 'open'`).bind(p.id).first();
    if (!still) continue;
    await mergeSame('recording', p.entity_a, p.entity_b);
    merged++;
  }
  return { merged, left: (await matchingTrackPairs()).length };
}

/**
 * Open "one album filed twice" pairs that are certainly one album: same
 * kind (album beside album, never a single beside its album), and titles
 * identical once edition words go ("Nine Track Mind (Special Edition)").
 * The looser "Title: Subtitle" matches are left to be judged one by one.
 */
export async function matchingAlbumPairs(): Promise<{ id: string; entity_a: string; entity_b: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.entity_a, a.entity_b, x.title AS ta, y.title AS tb, x.type = y.type AS same_type
     FROM anomaly a
     JOIN release_group x ON x.id = a.entity_a JOIN release_group y ON y.id = a.entity_b
     WHERE a.kind = 'near_duplicate_release_group' AND a.status = 'open'
     ORDER BY a.detected_at, a.id`,
  ).all<{ id: string; entity_a: string; entity_b: string; ta: string; tb: string; same_type: number }>();
  return results
    .filter((r) => r.same_type && normaliseTitle(r.ta) === normaliseTitle(r.tb))
    .map(({ id, entity_a, entity_b }) => ({ id, entity_a, entity_b }));
}

/** Merges every certain album pair, as mergeMatchingTracks does for songs. */
export async function mergeMatchingAlbums({ budgetMs }: { budgetMs: number }): Promise<{ merged: number; left: number }> {
  const stop = Date.now() + budgetMs;
  const { mergeSame } = await import('./merge');
  let merged = 0;
  for (const p of await matchingAlbumPairs()) {
    if (Date.now() > stop || merged >= 25) break;
    // A three-way duplicate: an earlier merge here may have taken one side.
    const still = await env.DB.prepare(`SELECT 1 FROM anomaly WHERE id = ? AND status = 'open'`).bind(p.id).first();
    if (!still) continue;
    await mergeSame('release_group', p.entity_a, p.entity_b);
    merged++;
  }
  return { merged, left: (await matchingAlbumPairs()).length };
}

/** Open duplicate-track pairs whose lengths agree, so they are one recording. */
export async function matchingTrackPairs(): Promise<{ id: string; entity_a: string; entity_b: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.entity_a, a.entity_b FROM anomaly a
     JOIN recording x ON x.id = a.entity_a JOIN recording y ON y.id = a.entity_b
     WHERE a.kind = 'near_duplicate_recording' AND a.status = 'open'
       AND abs(x.length_ms - y.length_ms) <= ?
     ORDER BY a.detected_at, a.id`,
  )
    .bind(REVIEW_RULES.sameLengthMs)
    .all<{ id: string; entity_a: string; entity_b: string }>();
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
    const [x, y] = a.entity_a < a.entity_b ? [a.entity_a, a.entity_b] : [a.entity_b, a.entity_a];
    statements.push(
      env.DB.prepare(`INSERT OR IGNORE INTO confirmed_distinct (entity_type, id_a, id_b) VALUES (?, ?, ?)`).bind(a.entity_type, x, y),
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
  if (a.kind !== 'near_duplicate_recording' && a.kind !== 'unlinked_rated_recording' && a.kind !== 'version_of_recording') {
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
  if (works.length > 1) throw new ReviewError('These recordings already belong to different songs.');

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

/** Open version pairs whose titles name the version: the ones "Link all" takes. */
export async function linkableVersions(): Promise<{ id: string; title: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT a.id, r.title FROM anomaly a JOIN recording r ON r.id = a.entity_b
     WHERE a.kind = 'version_of_recording' AND a.status = 'open' ORDER BY a.detected_at, a.id`,
  ).all<{ id: string; title: string }>();
  return results.filter((r) => splitVersion(r.title).version !== null);
}

/**
 * Links every open "another version" pair whose title names the version
 * (a remix, a live take) as versions of one song, until the budget runs
 * out. Two takes under one plain title are left to be judged one by one.
 */
export async function linkAllVersions({ budgetMs }: { budgetMs: number }): Promise<{ merged: number; left: number }> {
  const stop = Date.now() + budgetMs;
  let merged = 0;
  for (const { id } of await linkableVersions()) {
    if (Date.now() > stop || merged >= 300) break;
    try {
      await linkWork(id);
      merged++;
    } catch (error) {
      // Already in different songs: left for a person to judge.
      if (!(error instanceof ReviewError)) throw error;
      await env.DB.prepare(`UPDATE anomaly SET skipped_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).bind(id).run();
    }
  }
  return { merged, left: (await linkableVersions()).length };
}

export interface ReviewFact {
  label: string;
  value: string;
}

export interface ReviewEntity {
  id: string;
  title: string;
  href: string | null;
  /** A cover or picture, as a stored R2 key prefix. */
  art: string | null;
  /** Album covers are stored at sizes under the key; artist pictures are the key itself. */
  artKind: 'cover' | 'picture' | null;
  /** What tells two lookalikes apart, in the same order for both. */
  facts: ReviewFact[];
  source: string;
  mbid: string | null;
}

const minutes = (ms: number | null) => {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const TYPE_NAMES: Record<string, string> = {
  album: 'Album',
  ep: 'EP',
  single: 'Single',
  compilation: 'Compilation',
  mixtape: 'Mixtape',
  soundtrack: 'Soundtrack',
  live: 'Live',
};

/**
 * Names and the facts that matter for every entity in a set of items,
 * keyed by id, so a pair can be laid side by side and compared.
 */
export async function reviewEntities(anomalies: Anomaly[]): Promise<Map<string, ReviewEntity>> {
  const ids = (type: EntityType) =>
    JSON.stringify([...new Set(anomalies.filter((a) => a.entity_type === type).flatMap((a) => [a.entity_a, a.entity_b]).filter(Boolean))]);

  const [artists, recordings, groups] = await env.DB.batch([
    env.DB.prepare(
      `SELECT a.id, a.name AS title, a.source, a.mbid, a.disambiguation, a.area, a.kind,
              substr(a.begin_date, 1, 4) AS born,
              (SELECT count(*) FROM artist_credit c WHERE c.artist_id = a.id AND c.entity_type = 'release_group' AND c.role = 'primary') AS albums,
              (SELECT count(*) FROM artist_credit c WHERE c.artist_id = a.id AND c.entity_type = 'recording') AS songs,
              (SELECT i.key FROM artist_image i WHERE i.artist_id = a.id AND NOT i.hidden ORDER BY i.position LIMIT 1) AS art
       FROM artist a WHERE a.id IN (SELECT value FROM json_each(?))`,
    ).bind(ids('artist')),
    env.DB.prepare(
      `SELECT r.id, r.title, r.source, r.mbid, r.length_ms, substr(r.first_release_date, 1, 4) AS year,
              (SELECT group_concat(a.name, ', ') FROM artist_credit c JOIN artist a ON a.id = c.artist_id
               WHERE c.entity_type = 'recording' AND c.entity_id = r.id AND c.role = 'primary') AS artists,
              (SELECT group_concat(title, ', ') FROM (
                 SELECT DISTINCT g.title FROM track t JOIN release x ON x.id = t.release_id
                 JOIN release_group g ON g.id = x.release_group_id WHERE t.recording_id = r.id)) AS albums,
              (SELECT x.art_key FROM track t JOIN release x ON x.id = t.release_id
               WHERE t.recording_id = r.id AND x.art_key IS NOT NULL LIMIT 1) AS art,
              (SELECT count(*) FROM rating x WHERE x.entity_type = 'recording' AND x.entity_id = r.id) AS ratings,
              (SELECT count(*) FROM play p WHERE p.recording_id = r.id) AS plays
       FROM recording r WHERE r.id IN (SELECT value FROM json_each(?))`,
    ).bind(ids('recording')),
    env.DB.prepare(
      `SELECT g.id, g.title, g.source, g.mbid, g.type, substr(g.first_release_date, 1, 4) AS year,
              (SELECT group_concat(a.name, ', ') FROM artist_credit c JOIN artist a ON a.id = c.artist_id
               WHERE c.entity_type = 'release_group' AND c.entity_id = g.id AND c.role = 'primary') AS artists,
              (SELECT count(*) FROM release x WHERE x.release_group_id = g.id) AS editions,
              (SELECT count(t.id) FROM v_release_group_canonical k JOIN track t ON t.release_id = k.release_id
               WHERE k.release_group_id = g.id) AS tracks,
              (SELECT x.art_key FROM v_release_group_canonical k JOIN release x ON x.id = k.release_id WHERE k.release_group_id = g.id) AS art,
              (SELECT count(*) FROM rating x WHERE x.entity_type = 'release_group' AND x.entity_id = g.id) AS ratings
       FROM release_group g WHERE g.id IN (SELECT value FROM json_each(?))`,
    ).bind(ids('release_group')),
  ]);

  const map = new Map<string, ReviewEntity>();
  type Row = Record<string, string | number | null>;
  const text = (v: unknown) => (v == null ? '' : String(v));
  const count = (n: unknown, one: string, many: string) => `${Number(n)} ${Number(n) === 1 ? one : many}`;
  const base = (r: Row, href: string) => ({
    id: text(r.id),
    title: text(r.title),
    href,
    source: text(r.source),
    mbid: (r.mbid as string | null) ?? null,
  });

  for (const r of (artists?.results ?? []) as Row[]) {
    map.set(text(r.id), {
      ...base(r, `/artist/${r.id}`),
      art: (r.art as string | null) ?? null,
      artKind: r.art ? 'picture' : null,
      facts: [
        { label: 'Known as', value: text(r.disambiguation) },
        { label: 'From', value: text(r.area) },
        { label: 'Since', value: text(r.born) },
        { label: 'Albums', value: count(r.albums, 'album', 'albums') },
        { label: 'Songs', value: count(r.songs, 'song', 'songs') },
      ],
    });
  }
  for (const r of (recordings?.results ?? []) as Row[]) {
    map.set(text(r.id), {
      ...base(r, `/track/${r.id}`),
      art: (r.art as string | null) ?? null,
      artKind: r.art ? 'cover' : null,
      facts: [
        { label: 'By', value: text(r.artists) },
        { label: 'Length', value: minutes(r.length_ms as number | null) },
        { label: 'Year', value: text(r.year) },
        { label: 'On', value: text(r.albums) || 'no release' },
        { label: 'Rated', value: Number(r.ratings) > 0 ? count(r.ratings, 'time', 'times') : 'no' },
        { label: 'Played', value: Number(r.plays) > 0 ? count(r.plays, 'time', 'times') : '' },
      ],
    });
  }
  for (const r of (groups?.results ?? []) as Row[]) {
    map.set(text(r.id), {
      ...base(r, `/album/${r.id}`),
      art: (r.art as string | null) ?? null,
      artKind: r.art ? 'cover' : null,
      facts: [
        { label: 'By', value: text(r.artists) },
        { label: 'Kind', value: TYPE_NAMES[text(r.type)] ?? text(r.type) },
        { label: 'Year', value: text(r.year) },
        { label: 'Tracks', value: text(r.tracks) },
        { label: 'Editions', value: text(r.editions) },
        { label: 'Rated', value: Number(r.ratings) > 0 ? 'yes' : 'no' },
      ],
    });
  }
  return map;
}
