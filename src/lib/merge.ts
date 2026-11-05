/**
 * Merging two artist records that are one artist (the review queue's "two
 * artists with one name"). Everything attached to the one going away moves
 * to the one kept: credits, other names, links, pictures, hand edits. Its
 * external ids and details fill whatever the kept one lacks; its name
 * becomes another name for the kept one if it differs. Then its row goes,
 * and an entity_redirect keeps its old address working.
 *
 * Deleting is safe for artists: nothing is rated at artist level, so no
 * rating or history refers to the row. Albums and recordings are another
 * matter (ARCHITECTURE.md, "Review queue") and are not merged here.
 */

import { env } from 'cloudflare:workers';
import { ReviewError } from './review';

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
    db.prepare(`INSERT OR REPLACE INTO entity_redirect (entity_type, old_id, new_id) VALUES ('artist', ?, ?)`).bind(goneId, keepId),
    db.prepare(
      `UPDATE anomaly SET status = 'resolved', resolution = 'merged'
       WHERE status = 'open' AND entity_type = 'artist' AND (entity_a = ?1 OR entity_b = ?1)`,
    ).bind(goneId),
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
 * Score" is the deluxe of "Opening Night". Its editions, credits and genres
 * move to the kept album (its own hand edits are dropped), whose standard-edition rule then
 * decides which edition the score comes from; the emptied album goes, and
 * its address redirects.
 *
 * Refused while the album going away has ratings of its own: ratings are
 * append-only and cannot be moved, and whether to keep or snapshot them is
 * still an open question (ARCHITECTURE.md, "Review queue"). Track ratings
 * are unaffected either way, since recordings do not move.
 */
export async function mergeAlbums(keepId: string, goneId: string): Promise<void> {
  if (keepId === goneId) throw new ReviewError('An album cannot be merged with itself.');
  const db = env.DB;
  const rows = await db
    .prepare(`SELECT id FROM release_group WHERE id IN (?, ?)`)
    .bind(keepId, goneId)
    .all<{ id: string }>();
  if (rows.results.length !== 2) throw new ReviewError('One of these albums no longer exists.');
  const rated = await db
    .prepare(`SELECT count(*) AS n FROM rating WHERE entity_type = 'release_group' AND entity_id = ?`)
    .bind(goneId)
    .first<{ n: number }>();
  if ((rated?.n ?? 0) > 0) {
    throw new ReviewError('The album being folded in has album ratings of its own, which cannot be moved yet. Fold it the other way round, or wait for full merging.');
  }

  const goneSpotify = await db.prepare(`SELECT spotify_id FROM release_group WHERE id = ?`).bind(goneId).first<{ spotify_id: string | null }>();
  const moveEntity = (table: string) => [
    db.prepare(`UPDATE OR IGNORE ${table} SET entity_id = ?1 WHERE entity_type = 'release_group' AND entity_id = ?2`).bind(keepId, goneId),
    db.prepare(`DELETE FROM ${table} WHERE entity_type = 'release_group' AND entity_id = ?`).bind(goneId),
  ];

  await db.batch([
    db.prepare(`UPDATE release_group SET preferred_release_id = NULL WHERE id = ?`).bind(goneId),
    db.prepare(`UPDATE release SET release_group_id = ?1 WHERE release_group_id = ?2`).bind(keepId, goneId),
    // Its Spotify album fills the kept album's when that has none (the
    // column is unique, so it leaves the old row first).
    db.prepare(`UPDATE release_group SET spotify_id = NULL, mbid = NULL WHERE id = ?`).bind(goneId),
    db.prepare(`UPDATE release_group SET spotify_id = ?2 WHERE id = ?1 AND spotify_id IS NULL AND ?2 IS NOT NULL`).bind(keepId, goneSpotify?.spotify_id ?? null),
    ...moveEntity('artist_credit'),
    ...moveEntity('genre_tag'),
    // Its hand edits were about its own title and date, not the kept album's.
    db.prepare(`DELETE FROM field_override WHERE entity_type = 'release_group' AND entity_id = ?`).bind(goneId),
    db.prepare(`DELETE FROM queue_skip WHERE entity_type = 'release_group' AND entity_id = ?`).bind(goneId),
    db.prepare(`DELETE FROM queue_handoff WHERE entity_type = 'release_group' AND entity_id = ?`).bind(goneId),
    db.prepare(`UPDATE entity_redirect SET new_id = ?1 WHERE entity_type = 'release_group' AND new_id = ?2`).bind(keepId, goneId),
    db.prepare(`INSERT OR REPLACE INTO entity_redirect (entity_type, old_id, new_id) VALUES ('release_group', ?, ?)`).bind(goneId, keepId),
    db.prepare(
      `UPDATE anomaly SET status = 'resolved', resolution = 'merged'
       WHERE status = 'open' AND entity_type = 'release_group' AND (entity_a = ?1 OR entity_b = ?1)`,
    ).bind(goneId),
    db.prepare(`DELETE FROM search_index WHERE kind = 'release_group' AND entity_id = ?`).bind(goneId),
    db.prepare(`DELETE FROM release_group WHERE id = ?`).bind(goneId),
  ]);
}
