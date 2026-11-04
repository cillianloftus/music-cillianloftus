/**
 * Writes an ImportPlan to D1.
 *
 * Rules (ARCHITECTURE.md §5, "Matching"):
 *   - An entity whose external id is already held is the same entity. Its
 *     row is reused and only its NULL fields are filled. Nothing already
 *     present is overwritten, so hand corrections and field overrides are
 *     never clobbered.
 *   - An artist with no external id (typed by hand) is the existing artist
 *     of that name when exactly one exists; otherwise a new artist. Same-name
 *     artists are the review queue's to untangle, not the import's.
 *   - Importing an album that already exists attaches the new edition to
 *     the existing release group rather than creating a second group.
 *   - Nothing is deleted.
 *
 * Each table is written with one statement that reads its rows from a JSON
 * array via json_each. That keeps a whole album to about a dozen statements
 * (D1 caps statements per invocation and parameters per statement), and the
 * batch runs as one transaction: an import lands completely or not at all.
 */

import { env } from 'cloudflare:workers';
import type { ImportPlan } from './plan';

export interface WriteResult {
  releaseGroupId: string;
  releaseId: string;
  createdReleaseGroup: boolean;
  createdRelease: boolean;
}

type Table = 'artist' | 'work' | 'recording' | 'release_group' | 'release';

/** plan key -> existing local id, for every entity that matches one. */
async function resolveExisting(plan: ImportPlan): Promise<Record<Table, Map<string, string>>> {
  const byMbid = <T extends { key: string; mbid: string | null }>(entries: T[]) =>
    entries.filter((e): e is T & { mbid: string } => e.mbid !== null);

  const lookups: [Table, { key: string; mbid: string }[]][] = [
    ['artist', byMbid(plan.artists)],
    ['work', byMbid(plan.works)],
    ['recording', byMbid(plan.recordings)],
    ['release_group', byMbid([plan.releaseGroup])],
    ['release', byMbid([plan.release])],
  ];
  const unidentifiedArtists = plan.artists.filter((a) => a.mbid === null);

  const results = await env.DB.batch<{ id: string; mbid: string; name: string; matches: number }>([
    ...lookups.map(([table, entries]) =>
      env.DB.prepare(`SELECT id, mbid FROM ${table} WHERE mbid IN (SELECT value FROM json_each(?))`).bind(
        JSON.stringify(entries.map((e) => e.mbid)),
      ),
    ),
    // Hand-typed artists: the existing artist of that name, if unambiguous.
    env.DB.prepare(
      `SELECT min(id) AS id, lower(name) AS name, count(*) AS matches FROM artist
       WHERE lower(name) IN (SELECT lower(value) FROM json_each(?))
       GROUP BY lower(name)`,
    ).bind(JSON.stringify(unidentifiedArtists.map((a) => a.name))),
  ]);

  const resolved = {} as Record<Table, Map<string, string>>;
  lookups.forEach(([table, entries], i) => {
    const idByMbid = new Map(results[i]!.results.map((row) => [row.mbid, row.id]));
    resolved[table] = new Map(
      entries.flatMap((e) => (idByMbid.has(e.mbid) ? [[e.key, idByMbid.get(e.mbid)!] as const] : [])),
    );
  });

  const byName = new Map(results.at(-1)!.results.filter((r) => r.matches === 1).map((r) => [r.name, r.id]));
  for (const artist of unidentifiedArtists) {
    const id = byName.get(artist.name.toLowerCase());
    if (id) resolved.artist.set(artist.key, id);
  }
  return resolved;
}

export async function writePlan(plan: ImportPlan): Promise<WriteResult> {
  const existing = await resolveExisting(plan);

  const ids = {} as Record<Table, Map<string, string>>;
  for (const table of Object.keys(existing) as Table[]) {
    ids[table] = new Map(existing[table]);
  }
  const idFor = (table: Table, key: string): string => {
    let id = ids[table].get(key);
    if (!id) {
      id = crypto.randomUUID();
      ids[table].set(key, id);
    }
    return id;
  };

  const source = plan.source;
  const releaseGroupId = idFor('release_group', plan.releaseGroup.key);
  const releaseId = idFor('release', plan.release.key);

  const artists = plan.artists.map((a) => ({ ...a, id: idFor('artist', a.key), source }));
  const works = plan.works.map((w) => ({ ...w, id: idFor('work', w.key), source }));
  const recordings = plan.recordings.map((r) => ({
    ...r,
    id: idFor('recording', r.key),
    work_id: r.work_key ? idFor('work', r.work_key) : null,
    source,
  }));
  const tracks = plan.tracks.map((t) => ({
    ...t,
    id: crypto.randomUUID(),
    release_id: releaseId,
    recording_id: idFor('recording', t.recording_key),
  }));
  const credits = plan.credits.map((c) => ({
    ...c,
    id: crypto.randomUUID(),
    entity_id:
      c.entity === 'release_group'
        ? releaseGroupId
        : c.entity === 'release'
          ? releaseId
          : idFor('recording', c.entity_key),
    artist_id: idFor('artist', c.artist_key),
  }));

  const json = (rows: unknown) => JSON.stringify(rows);
  const db = env.DB;

  const statements: D1PreparedStatement[] = [
    // Artists
    db.prepare(
      `INSERT INTO artist (id, name, sort_name, disambiguation, mbid, source)
       SELECT j.value ->> '$.id', j.value ->> '$.name', j.value ->> '$.sort_name',
              j.value ->> '$.disambiguation', j.value ->> '$.mbid', j.value ->> '$.source'
       FROM json_each(?1) j WHERE true
       ON CONFLICT DO NOTHING`,
    ).bind(json(artists)),
    db.prepare(
      `UPDATE artist
       SET disambiguation = coalesce(artist.disambiguation, j.value ->> '$.disambiguation')
       FROM json_each(?1) j
       WHERE artist.id = j.value ->> '$.id'`,
    ).bind(json(artists)),

    // Works
    db.prepare(
      `INSERT INTO work (id, title, mbid, source)
       SELECT j.value ->> '$.id', j.value ->> '$.title', j.value ->> '$.mbid', j.value ->> '$.source'
       FROM json_each(?1) j WHERE true
       ON CONFLICT DO NOTHING`,
    ).bind(json(works)),

    // Release group
    db.prepare(
      `INSERT INTO release_group (id, title, type, status, first_release_date, date_precision, mbid, source)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT DO NOTHING`,
    ).bind(
      releaseGroupId,
      plan.releaseGroup.title,
      plan.releaseGroup.type,
      plan.releaseGroup.status,
      plan.releaseGroup.first_release_date,
      plan.releaseGroup.date_precision,
      plan.releaseGroup.mbid,
      source,
    ),
    // A date and its precision are filled together or not at all.
    db.prepare(
      `UPDATE release_group
       SET first_release_date = ?2, date_precision = ?3
       WHERE id = ?1 AND first_release_date IS NULL AND ?2 IS NOT NULL`,
    ).bind(releaseGroupId, plan.releaseGroup.first_release_date, plan.releaseGroup.date_precision),

    // Release (edition)
    db.prepare(
      `INSERT INTO release (id, release_group_id, title, date, date_precision, country, label, format, mbid, source)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT DO NOTHING`,
    ).bind(
      releaseId,
      releaseGroupId,
      plan.release.title,
      plan.release.date,
      plan.release.date_precision,
      plan.release.country,
      plan.release.label,
      plan.release.format,
      plan.release.mbid,
      source,
    ),
    db.prepare(
      `UPDATE release
       SET country = coalesce(country, ?2),
           label   = coalesce(label, ?3),
           format  = coalesce(format, ?4)
       WHERE id = ?1`,
    ).bind(releaseId, plan.release.country, plan.release.label, plan.release.format),

    // Recordings
    db.prepare(
      `INSERT INTO recording (id, work_id, title, length_ms, first_release_date, date_precision, mbid, isrc, source)
       SELECT j.value ->> '$.id', j.value ->> '$.work_id', j.value ->> '$.title',
              j.value ->> '$.length_ms', j.value ->> '$.first_release_date',
              j.value ->> '$.date_precision', j.value ->> '$.mbid', j.value ->> '$.isrc',
              j.value ->> '$.source'
       FROM json_each(?1) j WHERE true
       ON CONFLICT DO NOTHING`,
    ).bind(json(recordings)),
    db.prepare(
      `UPDATE recording
       SET work_id   = coalesce(recording.work_id, j.value ->> '$.work_id'),
           length_ms = coalesce(recording.length_ms, j.value ->> '$.length_ms'),
           isrc      = coalesce(recording.isrc, j.value ->> '$.isrc'),
           first_release_date = CASE WHEN recording.first_release_date IS NULL
                                     THEN j.value ->> '$.first_release_date'
                                     ELSE recording.first_release_date END,
           date_precision     = CASE WHEN recording.first_release_date IS NULL
                                     THEN j.value ->> '$.date_precision'
                                     ELSE recording.date_precision END
       FROM json_each(?1) j
       WHERE recording.id = j.value ->> '$.id'`,
    ).bind(json(recordings)),

    // Tracks: (release, disc, position) is unique, so a re-import is a no-op.
    db.prepare(
      `INSERT INTO track (id, release_id, recording_id, disc, position, title_on_release)
       SELECT j.value ->> '$.id', j.value ->> '$.release_id', j.value ->> '$.recording_id',
              j.value ->> '$.disc', j.value ->> '$.position', j.value ->> '$.title_on_release'
       FROM json_each(?1) j WHERE true
       ON CONFLICT DO NOTHING`,
    ).bind(json(tracks)),

    // Credits
    db.prepare(
      `INSERT INTO artist_credit (id, entity_type, entity_id, artist_id, role, position, credited_as, join_phrase)
       SELECT j.value ->> '$.id', j.value ->> '$.entity', j.value ->> '$.entity_id',
              j.value ->> '$.artist_id', j.value ->> '$.role', j.value ->> '$.position',
              j.value ->> '$.credited_as', j.value ->> '$.join_phrase'
       FROM json_each(?1) j WHERE true
       ON CONFLICT DO NOTHING`,
    ).bind(json(credits)),
  ];

  // genre_tag.source only admits sources that publish genres, plus manual.
  const genreSource = source === 'musicbrainz' || source === 'discogs' || source === 'manual';
  if (plan.releaseGroupGenres.length > 0 && genreSource) {
    const genres = plan.releaseGroupGenres.map((g) => ({ ...g, id: crypto.randomUUID() }));
    statements.push(
      // Unknown genres arrive unparented; placing them in the tree is a
      // curation decision, not an import one.
      db.prepare(
        `INSERT INTO genre (id, name)
         SELECT j.value ->> '$.id', j.value ->> '$.name'
         FROM json_each(?1) j WHERE true
         ON CONFLICT DO NOTHING`,
      ).bind(json(genres)),
      db.prepare(
        `INSERT INTO genre_tag (entity_type, entity_id, genre_id, source, weight)
         SELECT 'release_group', ?2, g.id, ?3, j.value ->> '$.weight'
         FROM json_each(?1) j
         JOIN genre g ON g.name = j.value ->> '$.name'
         WHERE true
         ON CONFLICT DO NOTHING`,
      ).bind(json(genres), releaseGroupId, source),
    );
  }

  await db.batch(statements);

  return {
    releaseGroupId,
    releaseId,
    createdReleaseGroup: !existing.release_group.has(plan.releaseGroup.key),
    createdRelease: !existing.release.has(plan.release.key),
  };
}
