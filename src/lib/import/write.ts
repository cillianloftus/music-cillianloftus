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
  type Keyed = { key: string; mbid: string | null; spotify_id?: string | null };
  const all: [Table, Keyed[]][] = [
    ['artist', plan.artists],
    ['work', plan.works],
    ['recording', plan.recordings],
    ['release_group', [plan.releaseGroup]],
    ['release', [plan.release]],
  ];
  const withMbid = all.map(([table, entries]) => [table, entries.filter((e) => e.mbid !== null)] as const);
  // Works have no Spotify id.
  const withSpotify = all
    .filter(([table]) => table !== 'work')
    .map(([table, entries]) => [table, entries.filter((e) => e.spotify_id)] as const);
  const artistNames = plan.artists.map((a) => a.name);
  // An ISRC names one recording; trusted only when exactly one row holds it.
  const byIsrc = plan.recordings.filter((r) => r.mbid === null && r.isrc);

  const results = await env.DB.batch<{ id: string; ext: string; name: string; matches: number; mbid: string | null; spotify_id: string | null }>([
    ...withMbid.map(([table, entries]) =>
      env.DB.prepare(`SELECT id, mbid AS ext FROM ${table} WHERE mbid IN (SELECT value FROM json_each(?))`).bind(
        JSON.stringify(entries.map((e) => e.mbid)),
      ),
    ),
    ...withSpotify.map(([table, entries]) =>
      env.DB.prepare(`SELECT id, spotify_id AS ext FROM ${table} WHERE spotify_id IN (SELECT value FROM json_each(?))`).bind(
        JSON.stringify(entries.map((e) => e.spotify_id)),
      ),
    ),
    env.DB.prepare(
      `SELECT min(id) AS id, isrc AS ext, count(*) AS matches FROM recording
       WHERE isrc IN (SELECT value FROM json_each(?)) GROUP BY isrc`,
    ).bind(JSON.stringify(byIsrc.map((r) => r.isrc))),
    // Everyone answering to a plan artist's name or alias (Benjamin Lasky
    // is Quadeca), for artists no id identifies.
    // Through the NOCASE name indexes (lower() could use neither: every
    // artist and alias read, 9,800 rows an import; this way about 30).
    // NOCASE folds case as lower() does, ASCII only, so the matches are the same.
    env.DB.prepare(
      `SELECT DISTINCT n.id, lower(n.name) AS name, a.mbid, a.spotify_id
       FROM (SELECT a1.id, a1.name FROM json_each(?1) j JOIN artist a1 ON a1.name = j.value COLLATE NOCASE
             UNION
             SELECT al.artist_id AS id, al.name FROM json_each(?1) j JOIN artist_alias al ON al.name = j.value) n
       JOIN artist a ON a.id = n.id`,
    ).bind(JSON.stringify(artistNames)),
  ]);

  const resolved = Object.fromEntries(all.map(([table]) => [table, new Map<string, string>()])) as Record<Table, Map<string, string>>;
  let i = 0;
  for (const [table, entries] of withMbid) {
    const ids = new Map(results[i++]!.results.map((row) => [row.ext, row.id]));
    for (const e of entries) if (ids.has(e.mbid!)) resolved[table].set(e.key, ids.get(e.mbid!)!);
  }
  for (const [table, entries] of withSpotify) {
    const ids = new Map(results[i++]!.results.map((row) => [row.ext, row.id]));
    for (const e of entries) if (!resolved[table].has(e.key) && ids.has(e.spotify_id!)) resolved[table].set(e.key, ids.get(e.spotify_id!)!);
  }
  const isrcIds = new Map(results[i++]!.results.filter((r) => r.matches === 1).map((r) => [r.ext, r.id]));
  for (const r of byIsrc) if (!resolved.recording.has(r.key) && isrcIds.has(r.isrc!)) resolved.recording.set(r.key, isrcIds.get(r.isrc!)!);

  // By name, when no id matched: the one artist of that name, provided it
  // holds no id that contradicts the plan's. So John Lindahl imported from
  // Spotify (no MusicBrainz id) is the John Lindahl a MusicBrainz import
  // brings, and gains the id; two artists that both have MusicBrainz ids
  // are never joined on a name.
  const byName = new Map<string, { id: string; mbid: string | null; spotify_id: string | null }[]>();
  for (const row of results[i]!.results) byName.set(row.name, [...(byName.get(row.name) ?? []), row]);
  for (const artist of plan.artists) {
    if (resolved.artist.has(artist.key)) continue;
    const candidates = byName.get(artist.name.toLowerCase()) ?? [];
    if (new Set(candidates.map((c) => c.id)).size !== 1) continue;
    const c = candidates[0]!;
    const mbidFits = !c.mbid || !artist.mbid || c.mbid === artist.mbid;
    const spotifyFits = !c.spotify_id || !artist.spotify_id || c.spotify_id === artist.spotify_id;
    if (mbidFits && spotifyFits) resolved.artist.set(artist.key, c.id);
  }
  return resolved;
}

export interface WriteOptions {
  /**
   * Attach the edition to this existing album instead of matching or
   * creating one: for a source with no shared id, once a caller has found
   * the album by title and artist.
   */
  intoReleaseGroup?: string;
}

export async function writePlan(plan: ImportPlan, options: WriteOptions = {}): Promise<WriteResult> {
  const existing = await resolveExisting(plan);
  if (options.intoReleaseGroup && !existing.release_group.has(plan.releaseGroup.key)) {
    existing.release_group.set(plan.releaseGroup.key, options.intoReleaseGroup);
  }

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
  // The title as the release prints it, when it differs only in capitals:
  // "born yesterday" on the album beats MusicBrainz's "Born Yesterday".
  const styled = new Map<string, string>();
  for (const t of plan.tracks) {
    const r = plan.recordings.find((x) => x.key === t.recording_key);
    if (r && t.title_on_release && !styled.has(r.key) && t.title_on_release.toLowerCase() === r.title.toLowerCase()) {
      styled.set(r.key, t.title_on_release);
    }
  }
  const recordings = plan.recordings.map((r) => ({
    ...r,
    title: styled.get(r.key) ?? r.title,
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

  /**
   * Fills an empty spotify_id. The column is unique, so an id another row
   * already holds is left alone rather than failing the whole import.
   */
  const fillSpotifyId = (table: 'artist' | 'recording' | 'release_group' | 'release', rows: { id: string; spotify_id?: string | null }[]) =>
    db.prepare(
      `UPDATE ${table}
       SET spotify_id = j.value ->> '$.spotify_id'
       FROM json_each(?1) j
       WHERE ${table}.id = j.value ->> '$.id'
         -- The + keeps SQLite off the spotify_id index: through it, every
         -- row still without an id was walked (most of the library) and the
         -- list scanned for each, about 200,000 rows a write. By id, a dozen.
         AND +${table}.spotify_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM field_override fo WHERE fo.entity_type = '${table}' AND fo.entity_id = ${table}.id AND fo.field = 'spotify_id')
         AND j.value ->> '$.spotify_id' IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${table} other WHERE other.spotify_id = j.value ->> '$.spotify_id')`,
    ).bind(json(rows.map((r) => ({ id: r.id, spotify_id: r.spotify_id ?? null }))));

  /**
   * Fills an empty mbid on a row found by another id (an album first built
   * from Spotify, now on MusicBrainz too), so later refreshes reach
   * MusicBrainz. Unique like spotify_id: one held elsewhere is left alone.
   */
  const fillMbid = (table: 'recording' | 'release_group' | 'release', rows: { id: string; mbid: string | null }[]) =>
    db.prepare(
      `UPDATE ${table}
       SET mbid = j.value ->> '$.mbid'
       FROM json_each(?1) j
       WHERE ${table}.id = j.value ->> '$.id'
         AND +${table}.mbid IS NULL -- by id, not through the mbid index (see above)
         AND j.value ->> '$.mbid' IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM ${table} other WHERE other.mbid = j.value ->> '$.mbid')`,
    ).bind(json(rows.map((r) => ({ id: r.id, mbid: r.mbid }))));

  const statements: D1PreparedStatement[] = [
    // Artists
    db.prepare(
      `INSERT INTO artist (id, name, sort_name, disambiguation, mbid, spotify_id, source)
       SELECT j.value ->> '$.id', j.value ->> '$.name', j.value ->> '$.sort_name',
              j.value ->> '$.disambiguation', j.value ->> '$.mbid', j.value ->> '$.spotify_id', j.value ->> '$.source'
       FROM json_each(?1) j WHERE true
       ON CONFLICT DO NOTHING`,
    ).bind(json(artists)),
    db.prepare(
      `UPDATE artist
       SET disambiguation = coalesce(artist.disambiguation, j.value ->> '$.disambiguation'),
           mbid = CASE WHEN artist.mbid IS NULL
                        AND NOT EXISTS (SELECT 1 FROM artist other WHERE other.mbid = j.value ->> '$.mbid')
                       THEN j.value ->> '$.mbid' ELSE artist.mbid END
       FROM json_each(?1) j
       WHERE artist.id = j.value ->> '$.id'`,
    ).bind(json(artists)),
    fillSpotifyId('artist', artists),

    // Works
    db.prepare(
      `INSERT INTO work (id, title, mbid, source)
       SELECT j.value ->> '$.id', j.value ->> '$.title', j.value ->> '$.mbid', j.value ->> '$.source'
       FROM json_each(?1) j WHERE true
       ON CONFLICT DO NOTHING`,
    ).bind(json(works)),

    // Release group
    db.prepare(
      `INSERT INTO release_group (id, title, type, status, first_release_date, date_precision, mbid, source, spotify_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
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
      plan.releaseGroup.spotify_id ?? null,
    ),
    fillSpotifyId('release_group', [{ id: releaseGroupId, spotify_id: plan.releaseGroup.spotify_id ?? null }]),
    fillMbid('release_group', [{ id: releaseGroupId, mbid: plan.releaseGroup.mbid }]),
    // A date and its precision are filled together or not at all.
    db.prepare(
      `UPDATE release_group
       SET first_release_date = ?2, date_precision = ?3
       WHERE id = ?1 AND first_release_date IS NULL AND ?2 IS NOT NULL`,
    ).bind(releaseGroupId, plan.releaseGroup.first_release_date, plan.releaseGroup.date_precision),

    // Release (edition)
    db.prepare(
      `INSERT INTO release (id, release_group_id, title, date, date_precision, country, label, format, mbid, source, spotify_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
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
      plan.release.spotify_id ?? null,
    ),
    fillSpotifyId('release', [{ id: releaseId, spotify_id: plan.release.spotify_id ?? null }]),
    fillMbid('release', [{ id: releaseId, mbid: plan.release.mbid }]),
    db.prepare(
      `UPDATE release
       SET country = coalesce(country, ?2),
           label   = CASE WHEN label IS NULL AND NOT EXISTS (
                       SELECT 1 FROM field_override o WHERE o.entity_type = 'release' AND o.entity_id = ?1 AND o.field = 'label')
                     THEN ?3 ELSE label END,
           format  = coalesce(format, ?4),
           barcode = coalesce(barcode, ?5)
       WHERE id = ?1`,
    ).bind(releaseId, plan.release.country, plan.release.label, plan.release.format, plan.release.barcode ?? null),

    // Recordings
    db.prepare(
      `INSERT INTO recording (id, work_id, title, length_ms, first_release_date, date_precision, mbid, isrc, spotify_id, source)
       SELECT j.value ->> '$.id', j.value ->> '$.work_id', j.value ->> '$.title',
              j.value ->> '$.length_ms', j.value ->> '$.first_release_date',
              j.value ->> '$.date_precision', j.value ->> '$.mbid', j.value ->> '$.isrc',
              j.value ->> '$.spotify_id', j.value ->> '$.source'
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
    fillSpotifyId('recording', recordings),
    fillMbid('recording', recordings),

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
       FROM json_each(?1) j
       -- A track or album whose credits were edited by hand keeps exactly those.
       WHERE NOT EXISTS (
         SELECT 1 FROM field_override o
         WHERE o.entity_type = j.value ->> '$.entity' AND o.entity_id = j.value ->> '$.entity_id' AND o.field = 'credits')
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
         FROM json_each(?1) j
         -- A name the library has renamed lands on the genre it became.
         WHERE NOT EXISTS (SELECT 1 FROM genre_alias a WHERE a.name = j.value ->> '$.name')
         ON CONFLICT DO NOTHING`,
      ).bind(json(genres)),
      db.prepare(
        `INSERT INTO genre_tag (entity_type, entity_id, genre_id, source, weight)
         SELECT 'release_group', ?2, g.id, ?3, j.value ->> '$.weight'
         FROM json_each(?1) j
         JOIN genre g ON g.id = coalesce((SELECT a.genre_id FROM genre_alias a WHERE a.name = j.value ->> '$.name'),
                                         (SELECT x.id FROM genre x WHERE x.name = j.value ->> '$.name'))
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
