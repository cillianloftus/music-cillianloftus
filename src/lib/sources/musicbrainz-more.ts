/**
 * More from MusicBrainz than an import takes, from two more requests per
 * album (migration 0055): its standard edition looked up again with each
 * track's genres and community rating and the links to the songs they
 * perform (whose "cover", "live" and "instrumental" marks say what kind of
 * recording each is), the edition's labels with catalogue numbers and its
 * packaging, the album's rating; and the lists, awards and series the
 * album is part of.
 *
 * Fill only: genres go in beside what is there (a track's genres set by
 * hand still stand alone, v_recording_genre), and nothing set by hand is
 * written over.
 */

import { env } from 'cloudflare:workers';
import { getReleaseGroupSeries, getReleaseMore } from '../musicbrainz/client';
import { preciseRole, roleForRelation, type PreciseRole } from '../import/musicbrainz';

interface Named {
  name: string;
  count: number;
}

interface Rating {
  value: number | null;
  'votes-count': number;
}

interface MoreRelation {
  type: string;
  'target-type': string;
  attributes?: string[];
  artist?: { id: string };
}

interface MoreRecording {
  id: string;
  genres?: Named[];
  rating?: Rating;
  relations?: MoreRelation[];
}

interface MoreRelease {
  packaging?: string | null;
  /** Credits on the release itself (a mastering engineer), which are every track's. */
  relations?: MoreRelation[];
  'label-info'?: {
    'catalog-number'?: string | null;
    label?: { id: string; name: string; 'sort-name'?: string; disambiguation?: string; type?: string | null; 'label-code'?: number | null } | null;
  }[];
  'release-group'?: { rating?: Rating };
  media: { tracks?: { recording: MoreRecording }[] }[];
}

interface SeriesLinks {
  relations?: {
    type: string;
    'target-type': string;
    direction?: string;
    'attribute-values'?: { number?: string };
    series?: { id: string; name: string; type?: string | null };
  }[];
}

export interface MoreFill {
  genres: number;
  kinds: number;
  labels: number;
  series: number;
  /** Credits made precise ("Alto saxophone" where it said "Performer"). */
  credits: number;
}

/**
 * A track's credits as precisely as MusicBrainz gives them, each with the
 * coarse role the import used to give it in its place: by artist MBID.
 * Only those that differ from the coarse role, the ones to put right. Pure.
 */
export function preciseCredits(relations: MoreRelation[]): { artist: string; role: PreciseRole; coarse: string }[] {
  const out = new Map<string, { artist: string; role: PreciseRole; coarse: string }>();
  for (const r of relations) {
    if (r['target-type'] !== 'artist' || !r.artist) continue;
    const role = preciseRole(r.type, r.attributes);
    const coarse = roleForRelation(r.type, r.attributes);
    if (!role || !coarse || role.id === coarse) continue;
    out.set(`${r.artist.id}:${role.id}`, { artist: r.artist.id, role, coarse });
  }
  return [...out.values()];
}

/** A track's genres worth keeping: voted for, weighted against its most voted. */
export function trackGenres(genres: Named[] = []): { name: string; weight: number }[] {
  const voted = genres.filter((g) => g.count > 0);
  const top = Math.max(0, ...voted.map((g) => g.count));
  // One vote among many is a passing tag; with few votes all count.
  const floor = top >= 4 ? top * 0.25 : 1;
  return voted
    .filter((g) => g.count >= floor)
    .sort((a, b) => b.count - a.count)
    .map((g) => ({ name: g.name, weight: Math.round((g.count / top) * 1000) / 1000 }));
}

/** What a recording is, from the attributes on its link to the song it performs. */
export function recordingKinds(recording: MoreRecording): { cover: 0 | 1; live: 0 | 1; instrumental: 0 | 1 } | null {
  const performances = (recording.relations ?? []).filter((r) => r.type === 'performance' && r['target-type'] === 'work');
  if (performances.length === 0) return null;
  const has = (attribute: string) => (performances.some((p) => p.attributes?.includes(attribute)) ? 1 : 0);
  return { cover: has('cover'), live: has('live'), instrumental: has('instrumental') };
}

/**
 * Credits whose precise role is the coarse role itself (someone credited
 * just as "performer", or on guitar): those coarse credits are right and stay.
 */
function coarseKept(
  recordings: MoreRecording[],
  releaseRelations: MoreRelation[],
  idFor: Map<string, string>,
): { recording: string; artist: string; precise: string }[] {
  const kept: { recording: string; artist: string; precise: string }[] = [];
  for (const recording of recordings) {
    const id = idFor.get(recording.id);
    if (!id) continue;
    for (const r of [...(recording.relations ?? []), ...releaseRelations]) {
      if (r['target-type'] !== 'artist' || !r.artist) continue;
      const role = preciseRole(r.type, r.attributes);
      if (role && role.id === roleForRelation(r.type, r.attributes)) kept.push({ recording: id, artist: r.artist.id, precise: role.id });
    }
  }
  return kept;
}

export async function fillMoreFromMusicBrainz(
  albumId: string,
  lookups: { release: (mbid: string) => Promise<MoreRelease>; series: (mbid: string) => Promise<SeriesLinks> } = {
    release: getReleaseMore<MoreRelease>,
    series: getReleaseGroupSeries<SeriesLinks>,
  },
): Promise<MoreFill> {
  const report: MoreFill = { genres: 0, kinds: 0, labels: 0, series: 0, credits: 0 };
  const row = await env.DB.prepare(
    `SELECT g.mbid AS group_mbid, r.id AS release_id, r.mbid AS release_mbid
     FROM release_group g
     JOIN v_release_group_canonical v ON v.release_group_id = g.id
     JOIN release r ON r.id = v.release_id
     WHERE g.id = ?`,
  )
    .bind(albumId)
    .first<{ group_mbid: string | null; release_id: string; release_mbid: string | null }>();
  const db = env.DB;
  const statements: D1PreparedStatement[] = [];

  if (row?.release_mbid) {
    const release = await lookups.release(row.release_mbid);
    const recordings = release.media.flatMap((m) => (m.tracks ?? []).map((t) => t.recording));
    const { results: ours } = await db
      .prepare(`SELECT r.id, r.mbid FROM recording r WHERE r.mbid IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(recordings.map((r) => r.id)))
      .all<{ id: string; mbid: string }>();
    const idFor = new Map(ours.map((o) => [o.mbid, o.id]));

    const tags: { recording: string; name: string; weight: number }[] = [];
    const precise: { recording: string; artist: string; role: string; label: string; coarse: string }[] = [];
    const roles = new Map<string, PreciseRole>();
    for (const recording of recordings) {
      const id = idFor.get(recording.id);
      if (!id) continue;
      for (const g of trackGenres(recording.genres)) tags.push({ recording: id, ...g });
      // The release's own credits are every track's, as the import has them.
      for (const c of preciseCredits([...(recording.relations ?? []), ...(release.relations ?? [])])) {
        roles.set(c.role.id, c.role);
        precise.push({ recording: id, artist: c.artist, role: c.role.id, label: c.role.label, coarse: c.coarse });
      }
      const kinds = recordingKinds(recording);
      const rating = recording.rating?.value != null && recording.rating['votes-count'] > 0 ? recording.rating : null;
      if (kinds) report.kinds += 1;
      if (kinds || rating) {
        statements.push(
          db
            .prepare(
              `UPDATE recording SET
                 is_cover = coalesce(is_cover, ?2), is_live = coalesce(is_live, ?3), is_instrumental = coalesce(is_instrumental, ?4),
                 mb_rating = coalesce(?5, mb_rating), mb_rating_votes = coalesce(?6, mb_rating_votes)
               WHERE id = ?1`,
            )
            .bind(id, kinds?.cover ?? null, kinds?.live ?? null, kinds?.instrumental ?? null, rating?.value ?? null, rating?.['votes-count'] ?? null),
        );
      }
    }
    if (precise.length > 0) {
      report.credits = precise.length;
      const notEdited = `NOT EXISTS (SELECT 1 FROM field_override o WHERE o.entity_type = 'recording' AND o.entity_id = j.value ->> '$.recording' AND o.field = 'credits')`;
      statements.push(
        // New roles, as the import adds them.
        db
          .prepare(
            `INSERT INTO credit_role (id, label, family, position)
             SELECT j.value ->> '$.id', j.value ->> '$.label', j.value ->> '$.family',
                    coalesce((SELECT max(position) FROM credit_role WHERE family = j.value ->> '$.family'), 90) + 1
             FROM json_each(?1) j
             WHERE NOT EXISTS (SELECT 1 FROM credit_role r WHERE r.id = j.value ->> '$.id' OR r.label = j.value ->> '$.label' COLLATE NOCASE)
             ON CONFLICT DO NOTHING`,
          )
          .bind(JSON.stringify([...roles.values()])),
        // The precise credit, for an artist the library has: under its id, or the role already called that.
        db
          .prepare(
            `INSERT INTO artist_credit (id, entity_type, entity_id, artist_id, role, position)
             SELECT lower(hex(randomblob(16))), 'recording', j.value ->> '$.recording', a.id,
                    coalesce((SELECT r.id FROM credit_role r WHERE r.id = j.value ->> '$.role'),
                             (SELECT r.id FROM credit_role r WHERE r.label = j.value ->> '$.label' COLLATE NOCASE)),
                    1
             FROM json_each(?1) j JOIN artist a ON a.mbid = j.value ->> '$.artist'
             WHERE ${notEdited}
               AND coalesce((SELECT r.id FROM credit_role r WHERE r.id = j.value ->> '$.role'),
                            (SELECT r.id FROM credit_role r WHERE r.label = j.value ->> '$.label' COLLATE NOCASE)) IS NOT NULL
             ON CONFLICT DO NOTHING`,
          )
          .bind(JSON.stringify(precise)),
        // And the coarse one it replaces, once the precise one is there, unless
        // another of their parts on the track is that coarse role itself.
        db
          .prepare(
            `DELETE FROM artist_credit
             WHERE id IN (
               SELECT c.id FROM json_each(?1) j
               JOIN artist a ON a.mbid = j.value ->> '$.artist'
               JOIN artist_credit c ON c.entity_type = 'recording' AND c.entity_id = j.value ->> '$.recording'
                                   AND c.artist_id = a.id AND c.role = j.value ->> '$.coarse'
               WHERE ${notEdited}
                 AND EXISTS (SELECT 1 FROM artist_credit p WHERE p.entity_type = 'recording' AND p.entity_id = c.entity_id
                             AND p.artist_id = a.id AND p.role <> c.role
                             -- The precise role by id or by name: two seeks, where an OR of them read every role.
                             AND (p.role = j.value ->> '$.role'
                                  OR p.role = (SELECT r.id FROM credit_role r WHERE r.label = j.value ->> '$.label' COLLATE NOCASE)))
                 AND NOT EXISTS (SELECT 1 FROM json_each(?2) k
                                 WHERE k.value ->> '$.recording' = c.entity_id AND k.value ->> '$.artist' = j.value ->> '$.artist'
                                   AND k.value ->> '$.precise' = c.role))`,
          )
          .bind(JSON.stringify(precise), JSON.stringify(coarseKept(recordings, release.relations ?? [], idFor))),
      );
    }
    if (tags.length > 0) {
      report.genres = tags.length;
      const named = [...new Set(tags.map((t) => t.name))].map((name) => ({ name, id: crypto.randomUUID() }));
      statements.push(
        // As an import does: a genre new to the library arrives unplaced in the tree.
        db
          .prepare(
            `INSERT INTO genre (id, name)
             SELECT j.value ->> '$.id', j.value ->> '$.name' FROM json_each(?1) j
             WHERE NOT EXISTS (SELECT 1 FROM genre_alias a WHERE a.name = j.value ->> '$.name')
             ON CONFLICT DO NOTHING`,
          )
          .bind(JSON.stringify(named)),
        db
          .prepare(
            `INSERT INTO genre_tag (entity_type, entity_id, genre_id, source, weight)
             SELECT 'recording', j.value ->> '$.recording', g.id, 'musicbrainz', j.value ->> '$.weight'
             FROM json_each(?1) j
             JOIN genre g ON g.id = coalesce((SELECT a.genre_id FROM genre_alias a WHERE a.name = j.value ->> '$.name'),
                                             (SELECT x.id FROM genre x WHERE x.name = j.value ->> '$.name'))
             WHERE true
             ON CONFLICT DO NOTHING`,
          )
          .bind(JSON.stringify(tags)),
      );
    }

    const albumRating = release['release-group']?.rating;
    if (albumRating?.value != null && albumRating['votes-count'] > 0) {
      statements.push(
        db.prepare(`UPDATE release_group SET mb_rating = ?2, mb_rating_votes = ?3 WHERE id = ?1`).bind(albumId, albumRating.value, albumRating['votes-count']),
      );
    }
    if (release.packaging && release.packaging !== 'None') {
      statements.push(db.prepare(`UPDATE release SET packaging = coalesce(packaging, ?2) WHERE id = ?1`).bind(row.release_id, release.packaging));
    }
    for (const info of release['label-info'] ?? []) {
      const label = info.label;
      // MusicBrainz's "[no label]" is no label.
      if (!label?.id || label.name === '[no label]') continue;
      report.labels += 1;
      statements.push(
        db
          .prepare(
            `INSERT INTO label (id, mbid, name, sort_name, disambiguation, type, label_code) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (mbid) DO NOTHING`,
          )
          .bind(crypto.randomUUID(), label.id, label.name, label['sort-name'] ?? null, label.disambiguation || null, label.type ?? null, label['label-code'] ?? null),
        db
          .prepare(
            `INSERT INTO release_label (release_id, label_id, catalog_number)
             SELECT ?1, l.id, ?3 FROM label l WHERE l.mbid = ?2
             ON CONFLICT (release_id, label_id) DO UPDATE SET catalog_number = coalesce(catalog_number, excluded.catalog_number)`,
          )
          .bind(row.release_id, label.id, info['catalog-number'] || null),
      );
    }
  }

  if (row?.group_mbid) {
    const links = await lookups.series(row.group_mbid);
    for (const link of links.relations ?? []) {
      const s = link.series;
      if (link.type !== 'part of' || link['target-type'] !== 'series' || link.direction === 'backward' || !s) continue;
      report.series += 1;
      statements.push(
        db.prepare(`INSERT INTO series (id, mbid, name, type) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (mbid) DO NOTHING`).bind(crypto.randomUUID(), s.id, s.name, s.type ?? null),
        db
          .prepare(
            `INSERT INTO release_group_series (release_group_id, series_id, number)
             SELECT ?1, s.id, ?3 FROM series s WHERE s.mbid = ?2
             ON CONFLICT DO NOTHING`,
          )
          .bind(albumId, s.id, link['attribute-values']?.number ?? null),
      );
    }
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO lookup_log (source, entity_id, found) VALUES ('musicbrainz-more', ?, ?)
         ON CONFLICT (source, entity_id) DO UPDATE SET found = excluded.found, looked_at = excluded.looked_at`,
      )
      .bind(albumId, row?.release_mbid || row?.group_mbid ? 1 : 0),
  );
  await db.batch(statements);
  return report;
}

/**
 * Albums from MusicBrainz not looked at again for this (never, or not in
 * six months: lists and ratings grow), newest first, until the budget runs
 * out. Two requests an album at MusicBrainz's one a second.
 */
export async function fillAlbumsMoreFromMusicBrainz({
  budgetMs,
  limit = 20,
}: {
  budgetMs: number;
  limit?: number;
}): Promise<{ albums: number; genres: number; kinds: number; labels: number; series: number; credits: number; left: number }> {
  const deadline = Date.now() + budgetMs;
  const waiting = `FROM release_group g
     WHERE g.mbid IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM lookup_log l WHERE l.source = 'musicbrainz-more' AND l.entity_id = g.id AND l.looked_at > datetime('now', '-180 days'))`;
  const { results } = await env.DB.prepare(`SELECT g.id ${waiting} ORDER BY g.created_at DESC LIMIT ?`).bind(limit).all<{ id: string }>();
  const report = { albums: 0, genres: 0, kinds: 0, labels: 0, series: 0, credits: 0, left: 0 };
  for (const { id } of results) {
    if (Date.now() > deadline) break;
    try {
      const done = await fillMoreFromMusicBrainz(id);
      report.genres += done.genres;
      report.kinds += done.kinds;
      report.labels += done.labels;
      report.series += done.series;
      report.credits += done.credits;
    } catch (error) {
      console.warn('MusicBrainz more failed', id, error);
    }
    report.albums += 1;
  }
  report.left = (await env.DB.prepare(`SELECT count(*) AS n ${waiting}`).first<{ n: number }>())?.n ?? 0;
  return report;
}
