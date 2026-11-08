/**
 * Merging two records that are one thing: the review queue's "Are these
 * the same?". Everything attached to the one going away moves to the one
 * kept (credits, names, pictures, tracks, editions, plays, files, both
 * rating histories), its ids and details fill whatever the kept one lacks,
 * and then its row goes. Its old address redirects, and the row itself is
 * kept whole in the redirect (snapshot_json), so nothing is lost.
 *
 * Ratings move by their entity_id, which append-only allows: no score or
 * date changes, and a merged history reads as one, the latest counting.
 */

import { env } from 'cloudflare:workers';
import { ReviewError } from './review';
import { normaliseTitle } from './text';

/** The redirect from a merged-away id, carrying the row as it was. */
function redirect(type: string, goneId: string, keepId: string, row: Record<string, unknown>): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT OR REPLACE INTO entity_redirect (entity_type, old_id, new_id, snapshot_json, merged_at)
     VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  ).bind(type, goneId, keepId, JSON.stringify(row));
}

const FILLABLE = ['mbid', 'spotify_id', 'wikidata_id', 'disambiguation', 'kind', 'area', 'enriched_at'] as const;

export async function mergeArtists(keepId: string, goneId: string): Promise<void> {
  if (keepId === goneId) throw new ReviewError('An artist cannot be merged with itself.');
  const [keep, gone] = await Promise.all(
    [keepId, goneId].map((id) => env.DB.prepare(`SELECT * FROM artist WHERE id = ?`).bind(id).first<Record<string, string | null>>()),
  );
  if (!keep || !gone) throw new ReviewError('One of these artists no longer exists.');

  const db = env.DB;
  const move = (table: string, column: string) => [
    // Rows that would collide with one the kept artist already has are dropped.
    db.prepare(`UPDATE OR IGNORE ${table} SET ${column} = ?1 WHERE ${column} = ?2`).bind(keepId, goneId),
    db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).bind(goneId),
  ];

  // Entities crediting both: after the merge they would list one artist twice.
  const collisions = await db
    .prepare(
      `SELECT DISTINCT g.entity_type, g.entity_id FROM artist_credit g
       JOIN artist_credit k ON k.entity_type = g.entity_type AND k.entity_id = g.entity_id AND k.role = g.role AND k.artist_id = ?1
       WHERE g.artist_id = ?2`,
    )
    .bind(keepId, goneId)
    .all<{ entity_type: string; entity_id: string }>();

  const fills = FILLABLE.filter((c) => keep[c] == null && gone[c] != null);
  const dateFills = (['begin', 'end'] as const).filter((p) => keep[`${p}_date`] == null && gone[`${p}_date`] != null);

  await db.batch([
    // Unique ids first leave the old row, so the kept row can take them.
    db.prepare(`UPDATE artist SET mbid = NULL, spotify_id = NULL WHERE id = ?`).bind(goneId),
    ...fills.map((c) => db.prepare(`UPDATE artist SET ${c} = ? WHERE id = ?`).bind(gone[c], keepId)),
    ...dateFills.map((p) =>
      db.prepare(`UPDATE artist SET ${p}_date = ?, ${p}_precision = ? WHERE id = ?`).bind(gone[`${p}_date`], gone[`${p}_precision`], keepId),
    ),

    ...move('artist_credit', 'artist_id'),
    ...move('artist_alias', 'artist_id'),
    ...move('artist_image', 'artist_id'),
    db.prepare(`UPDATE OR IGNORE artist_link SET artist_id = ?1 WHERE artist_id = ?2`).bind(keepId, goneId),
    db.prepare(`UPDATE OR IGNORE artist_link SET other_id = ?1 WHERE other_id = ?2`).bind(keepId, goneId),
    db.prepare(`DELETE FROM artist_link WHERE artist_id = ?1 OR other_id = ?1 OR artist_id = other_id`).bind(goneId),
    db.prepare(`UPDATE OR IGNORE field_override SET entity_id = ?1 WHERE entity_type = 'artist' AND entity_id = ?2`).bind(keepId, goneId),
    db.prepare(`DELETE FROM field_override WHERE entity_type = 'artist' AND entity_id = ?`).bind(goneId),

    // Its name, when spelt differently, is another name for the kept artist.
    db.prepare(
      `INSERT INTO artist_alias (artist_id, name, kind, source)
       SELECT ?1, ?2, 'alias', 'manual' WHERE ?2 <> (SELECT name FROM artist WHERE id = ?1) COLLATE BINARY
       ON CONFLICT DO NOTHING`,
    ).bind(keepId, gone.name),

    // Anything pointing at the old id now points on.
    db.prepare(`UPDATE entity_redirect SET new_id = ?1 WHERE entity_type = 'artist' AND new_id = ?2`).bind(keepId, goneId),
    redirect('artist', goneId, keepId, gone),
    db.prepare(
      `UPDATE anomaly SET status = 'resolved', resolution = 'merged'
       WHERE status = 'open' AND entity_type = 'artist' AND (entity_a = ?1 OR entity_b = ?1)`,
    ).bind(goneId),
    db.prepare(`DELETE FROM confirmed_distinct WHERE entity_type = 'artist' AND (id_a = ?1 OR id_b = ?1)`).bind(goneId),
    db.prepare(`DELETE FROM search_index WHERE kind = 'artist' AND entity_id = ?`).bind(goneId),
    db.prepare(`DELETE FROM artist WHERE id = ?`).bind(goneId),
  ]);

  await tidyCredits(collisions.results);
}

/**
 * Where both artists were credited on one entity, the merge leaves one
 * credit: renumber that entity's primaries and end the line cleanly.
 * Join phrases otherwise stay as the source wrote them (" feat. " included).
 */
async function tidyCredits(entities: { entity_type: string; entity_id: string }[]): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const e of entities) {
    const { results } = await env.DB.prepare(
      `SELECT id FROM artist_credit WHERE entity_type = ? AND entity_id = ? AND role = 'primary' ORDER BY position, id`,
    )
      .bind(e.entity_type, e.entity_id)
      .all<{ id: string }>();
    results.forEach((r, i) =>
      statements.push(
        env.DB.prepare(
          `UPDATE artist_credit SET position = ?1,
             join_phrase = CASE WHEN ?2 AND NOT EXISTS (SELECT 1 FROM artist_credit f WHERE f.entity_type = artist_credit.entity_type
                                  AND f.entity_id = artist_credit.entity_id AND f.role = 'featured')
                                THEN '' ELSE join_phrase END
           WHERE id = ?3`,
        ).bind(i + 1, i === results.length - 1 ? 1 : 0, r.id),
      ),
    );
  }
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
}

/**
 * Files one album as editions of another: "Opening Night: The Complete
 * Score" is the deluxe of "Opening Night". Its editions (with any copies
 * owned), credits, genres and album ratings move to the kept album, whose
 * standard-edition rule then decides which edition the score comes from;
 * its ids fill the kept album's gaps; the emptied album goes, and its
 * address redirects.
 */
export async function mergeAlbums(keepId: string, goneId: string): Promise<void> {
  if (keepId === goneId) throw new ReviewError('An album cannot be merged with itself.');
  const db = env.DB;
  const [keep, gone] = await Promise.all(
    [keepId, goneId].map((id) => db.prepare(`SELECT * FROM release_group WHERE id = ?`).bind(id).first<Record<string, unknown>>()),
  );
  if (!keep || !gone) throw new ReviewError('One of these albums no longer exists.');
  const arriving = (await db.prepare(`SELECT id FROM release WHERE release_group_id = ?`).bind(goneId).all<{ id: string }>()).results.map((r) => r.id);

  const moveEntity = (table: string) => [
    db.prepare(`UPDATE OR IGNORE ${table} SET entity_id = ?1 WHERE entity_type = 'release_group' AND entity_id = ?2`).bind(keepId, goneId),
    db.prepare(`DELETE FROM ${table} WHERE entity_type = 'release_group' AND entity_id = ?`).bind(goneId),
  ];
  const fill = (column: string) =>
    db.prepare(`UPDATE release_group SET ${column} = ?2 WHERE id = ?1 AND ${column} IS NULL AND ?2 IS NOT NULL`).bind(keepId, gone[column] ?? null);

  await db.batch([
    db.prepare(`UPDATE release_group SET preferred_release_id = NULL WHERE id = ?`).bind(goneId),
    db.prepare(`UPDATE release SET release_group_id = ?1 WHERE release_group_id = ?2`).bind(keepId, goneId),
    // Unique ids leave the old row first, so the kept row can take them.
    db.prepare(`UPDATE release_group SET spotify_id = NULL, mbid = NULL WHERE id = ?`).bind(goneId),
    fill('spotify_id'),
    fill('mbid'),
    db.prepare(
      `UPDATE release_group SET first_release_date = ?2, date_precision = ?3
       WHERE id = ?1 AND first_release_date IS NULL AND ?2 IS NOT NULL`,
    ).bind(keepId, gone.first_release_date ?? null, gone.date_precision ?? 'unknown'),
    db.prepare(`UPDATE release_group SET official = 1 WHERE id = ?1 AND ?2 = 1`).bind(keepId, gone.official ?? null),
    // Both rating histories become one; the latest still counts.
    db.prepare(`UPDATE rating SET entity_id = ?1 WHERE entity_type = 'release_group' AND entity_id = ?2`).bind(keepId, goneId),
    ...moveEntity('artist_credit'),
    ...moveEntity('genre_tag'),
    // Its hand edits were about its own title and date, not the kept album's.
    db.prepare(`DELETE FROM field_override WHERE entity_type = 'release_group' AND entity_id = ?`).bind(goneId),
    db.prepare(`DELETE FROM queue_skip WHERE entity_type = 'release_group' AND entity_id = ?`).bind(goneId),
    db.prepare(`DELETE FROM queue_handoff WHERE entity_type = 'release_group' AND entity_id = ?`).bind(goneId),
    db.prepare(`DELETE FROM lookup_log WHERE entity_id = ?`).bind(goneId),
    db.prepare(`UPDATE entity_redirect SET new_id = ?1 WHERE entity_type = 'release_group' AND new_id = ?2`).bind(keepId, goneId),
    redirect('release_group', goneId, keepId, gone),
    db.prepare(
      `UPDATE anomaly SET status = 'resolved', resolution = 'merged'
       WHERE status = 'open' AND entity_type = 'release_group' AND (entity_a = ?1 OR entity_b = ?1)`,
    ).bind(goneId),
    db.prepare(`DELETE FROM confirmed_distinct WHERE entity_type = 'release_group' AND (id_a = ?1 OR id_b = ?1)`).bind(goneId),
    db.prepare(`DELETE FROM search_index WHERE kind = 'release_group' AND entity_id = ?`).bind(goneId),
    db.prepare(`DELETE FROM release_group WHERE id = ?`).bind(goneId),
  ]);
  await foldDuplicateEditions(keepId, arriving);
  // The 2023 original merged into its 2026 re-release dates the album 2023.
  const { albumDateFromEditions } = await import('./editions');
  await albumDateFromEditions(keepId);
}

/**
 * After a merge, an edition that arrived which is one the album already
 * had (the Special Edition from MusicBrainz beside the same one imported
 * from Spotify) is folded into it, so the album does not list it twice.
 * Two editions are one when their tracklists match title for title, in
 * order. The songs on the one going are merged into the kept one's, track
 * by track; copies owned move across; its ids and art fill gaps.
 */
export async function foldDuplicateEditions(albumId: string, arriving: string[]): Promise<number> {
  if (arriving.length === 0) return 0;
  const db = env.DB;
  const { results: rows } = await db
    .prepare(
      `SELECT x.id AS release_id, x.mbid, x.art_key, x.created_at, t.recording_id, coalesce(t.title_on_release, r.title) AS title
       FROM release x LEFT JOIN track t ON t.release_id = x.id LEFT JOIN recording r ON r.id = t.recording_id
       WHERE x.release_group_id = ?
       ORDER BY x.id, t.disc, t.position`,
    )
    .bind(albumId)
    .all<{ release_id: string; mbid: string | null; art_key: string | null; created_at: string; recording_id: string | null; title: string | null }>();

  type Edition = { id: string; mbid: string | null; art: string | null; created: string; recordings: string[]; key: string };
  const editions = new Map<string, Edition>();
  for (const r of rows) {
    let e = editions.get(r.release_id);
    if (!e) editions.set(r.release_id, (e = { id: r.release_id, mbid: r.mbid, art: r.art_key, created: r.created_at, recordings: [], key: '' }));
    if (r.recording_id) e.recordings.push(r.recording_id);
    if (r.title !== null) e.key += `${normaliseTitle(r.title)}\u0000`;
  }
  // Keep the edition with MusicBrainz behind it, then art, then the older.
  const rank = (e: Edition) => [e.mbid ? 0 : 1, e.art ? 0 : 1, e.created] as const;
  const better = (a: Edition, b: Edition) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : 1);
  };

  let folded = 0;
  const gone = new Set<string>();
  for (const id of arriving) {
    const incoming = editions.get(id);
    if (!incoming || incoming.recordings.length === 0 || gone.has(id)) continue;
    const twin = [...editions.values()].find(
      (e) => e.id !== id && !gone.has(e.id) && !arriving.includes(e.id) && e.recordings.length === incoming.recordings.length && e.key === incoming.key,
    );
    if (!twin) continue;
    const [kept, going] = better(twin, incoming) <= 0 ? [twin, incoming] : [incoming, twin];

    // Track by track, the same song: one recording.
    for (let i = 0; i < kept.recordings.length; i++) {
      const [k, g] = [kept.recordings[i]!, going.recordings[i]!];
      if (k !== g) {
        const both = await db.prepare(`SELECT count(*) AS n FROM recording WHERE id IN (?, ?)`).bind(k, g).first<{ n: number }>();
        if (both?.n === 2) await mergeRecordings(k, g);
      }
    }

    const row = await db.prepare(`SELECT * FROM release WHERE id = ?`).bind(going.id).first<Record<string, unknown>>();
    const fill = (column: string) =>
      db.prepare(`UPDATE release SET ${column} = ?2 WHERE id = ?1 AND ${column} IS NULL AND ?2 IS NOT NULL`).bind(kept.id, row?.[column] ?? null);
    await db.batch([
      db.prepare(`UPDATE release_group SET preferred_release_id = ?1 WHERE preferred_release_id = ?2`).bind(kept.id, going.id),
      db.prepare(`UPDATE release SET mbid = NULL, spotify_id = NULL WHERE id = ?`).bind(going.id),
      ...['mbid', 'spotify_id', 'art_key', 'barcode', 'label', 'country', 'format', 'note'].map(fill),
      db.prepare(`UPDATE holding SET release_id = ?1 WHERE release_id = ?2`).bind(kept.id, going.id),
      db.prepare(`UPDATE OR IGNORE artist_credit SET entity_id = ?1 WHERE entity_type = 'release' AND entity_id = ?2`).bind(kept.id, going.id),
      db.prepare(`DELETE FROM artist_credit WHERE entity_type = 'release' AND entity_id = ?`).bind(going.id),
      db.prepare(`DELETE FROM field_override WHERE entity_type = 'release' AND entity_id = ?`).bind(going.id),
      db.prepare(`DELETE FROM lookup_log WHERE entity_id = ?`).bind(going.id),
      db.prepare(`UPDATE entity_redirect SET new_id = ?1 WHERE entity_type = 'release' AND new_id = ?2`).bind(kept.id, going.id),
      redirect('release', going.id, kept.id, row ?? {}),
      db.prepare(`DELETE FROM track WHERE release_id = ?`).bind(going.id),
      db.prepare(`DELETE FROM release WHERE id = ?`).bind(going.id),
    ]);
    gone.add(going.id);
    folded++;
  }
  return folded;
}

/**
 * Two records of one song: the single's version and the album's, a hand
 * entry beside an import. Every track using the one going away uses the
 * kept one instead, and its ratings, plays, files, playlist pins, credits
 * and genres follow; its ids, length and work fill the kept one's gaps.
 */
export async function mergeRecordings(keepId: string, goneId: string): Promise<void> {
  if (keepId === goneId) throw new ReviewError('A song cannot be merged with itself.');
  const db = env.DB;
  const [keep, gone] = await Promise.all(
    [keepId, goneId].map((id) => db.prepare(`SELECT * FROM recording WHERE id = ?`).bind(id).first<Record<string, unknown>>()),
  );
  if (!keep || !gone) throw new ReviewError('One of these songs no longer exists.');

  const moveEntity = (table: string) => [
    db.prepare(`UPDATE OR IGNORE ${table} SET entity_id = ?1 WHERE entity_type = 'recording' AND entity_id = ?2`).bind(keepId, goneId),
    db.prepare(`DELETE FROM ${table} WHERE entity_type = 'recording' AND entity_id = ?`).bind(goneId),
  ];
  const moveColumn = (table: string) => [
    db.prepare(`UPDATE OR IGNORE ${table} SET recording_id = ?1 WHERE recording_id = ?2`).bind(keepId, goneId),
    db.prepare(`DELETE FROM ${table} WHERE recording_id = ?`).bind(goneId),
  ];
  const fill = (column: string) =>
    db.prepare(`UPDATE recording SET ${column} = ?2 WHERE id = ?1 AND ${column} IS NULL AND ?2 IS NOT NULL`).bind(keepId, gone[column] ?? null);

  await db.batch([
    // A work whose preferred version is going away prefers none until one is chosen again.
    db.prepare(`UPDATE work SET preferred_recording_id = NULL WHERE preferred_recording_id = ?`).bind(goneId),
    db.prepare(`UPDATE recording SET mbid = NULL, spotify_id = NULL WHERE id = ?`).bind(goneId),
    fill('mbid'),
    fill('spotify_id'),
    fill('isrc'),
    fill('length_ms'),
    fill('genius_url'),
    fill('work_id'),
    db.prepare(
      `UPDATE recording SET first_release_date = ?2, date_precision = ?3
       WHERE id = ?1 AND first_release_date IS NULL AND ?2 IS NOT NULL`,
    ).bind(keepId, gone.first_release_date ?? null, gone.date_precision ?? 'unknown'),
    db.prepare(`UPDATE track SET recording_id = ?1 WHERE recording_id = ?2`).bind(keepId, goneId),
    db.prepare(`UPDATE rating SET entity_id = ?1 WHERE entity_type = 'recording' AND entity_id = ?2`).bind(keepId, goneId),
    db.prepare(`UPDATE play SET recording_id = ?1 WHERE recording_id = ?2`).bind(keepId, goneId),
    ...moveColumn('file'),
    ...moveColumn('definition_pin'),
    ...moveColumn('definition_exclude'),
    ...moveColumn('recording_kind'),
    ...moveColumn('recording_kind_skip'),
    ...moveEntity('artist_credit'),
    ...moveEntity('genre_tag'),
    ...moveEntity('field_override'),
    db.prepare(`DELETE FROM queue_skip WHERE entity_type = 'recording' AND entity_id = ?`).bind(goneId),
    db.prepare(`DELETE FROM queue_handoff WHERE entity_type = 'recording' AND entity_id = ?`).bind(goneId),
    db.prepare(`DELETE FROM lookup_log WHERE entity_id = ?`).bind(goneId),
    db.prepare(`UPDATE entity_redirect SET new_id = ?1 WHERE entity_type = 'recording' AND new_id = ?2`).bind(keepId, goneId),
    redirect('recording', goneId, keepId, gone),
    db.prepare(
      `UPDATE anomaly SET status = 'resolved', resolution = 'merged'
       WHERE status = 'open' AND entity_type = 'recording' AND (entity_a = ?1 OR entity_b = ?1)`,
    ).bind(goneId),
    db.prepare(`DELETE FROM confirmed_distinct WHERE entity_type = 'recording' AND (id_a = ?1 OR id_b = ?1)`).bind(goneId),
    db.prepare(`DELETE FROM search_index WHERE kind = 'recording' AND entity_id = ?`).bind(goneId),
    db.prepare(`DELETE FROM recording WHERE id = ?`).bind(goneId),
  ]);
}

export type MergeType = 'artist' | 'release_group' | 'recording';

/**
 * Which of two records to keep, so "Same: merge them" needs no second
 * question: the one holding more of Cillian's data and more to go on.
 * Everything moves either way; this only decides whose id and spelling stay.
 */
export async function survivor(type: MergeType, a: string, b: string): Promise<[keep: string, gone: string]> {
  const weight: Record<MergeType, string> = {
    artist: `(SELECT count(*) FROM artist_credit c WHERE c.artist_id = x.id) + 1000 * (x.mbid IS NOT NULL)`,
    release_group: `10000 * EXISTS (SELECT 1 FROM rating r WHERE r.entity_type = 'release_group' AND r.entity_id = x.id)
      + 1000 * (x.mbid IS NOT NULL) + 500 * coalesce(x.official, 1) - 400 * (x.type = 'live')
      + (SELECT count(*) FROM release e JOIN track t ON t.release_id = e.id WHERE e.release_group_id = x.id)`,
    recording: `10000 * EXISTS (SELECT 1 FROM rating r WHERE r.entity_type = 'recording' AND r.entity_id = x.id)
      + 1000 * (x.mbid IS NOT NULL)
      + 100 * (SELECT count(*) FROM track t JOIN release e ON e.id = t.release_id JOIN release_group g ON g.id = e.release_group_id
               WHERE t.recording_id = x.id AND g.type <> 'live' AND coalesce(g.official, 1) = 1)
      + (SELECT count(*) FROM play p WHERE p.recording_id = x.id)`,
  };
  const { results } = await env.DB.prepare(`SELECT x.id, ${weight[type]} AS w FROM ${type} x WHERE x.id IN (?, ?)`)
    .bind(a, b)
    .all<{ id: string; w: number }>();
  const wa = results.find((r) => r.id === a)?.w ?? 0;
  const wb = results.find((r) => r.id === b)?.w ?? 0;
  return wb > wa ? [b, a] : [a, b];
}

/** Merges two records judged the same, keeping whichever survivor() picks. Returns the one kept. */
export async function mergeSame(type: MergeType, a: string, b: string): Promise<string> {
  const [keep, gone] = await survivor(type, a, b);
  if (type === 'artist') await mergeArtists(keep, gone);
  else if (type === 'release_group') await mergeAlbums(keep, gone);
  else await mergeRecordings(keep, gone);
  return keep;
}
