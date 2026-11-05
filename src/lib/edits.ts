/**
 * Corrections by hand (ARCHITECTURE.md §3, "Provenance and corrections").
 * An edit writes the new value to the row and records it in field_override,
 * which marks the field as Cillian's: imports and enrichment fill empty
 * fields only and skip any field with an override, so a correction is
 * never replaced by a later sync. Reverting deletes the override.
 */

import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { parsePartialDate } from './dates';

export class EditError extends Error {}

const partialDate = z
  .string()
  .trim()
  .max(10)
  .refine((v) => v === '' || parsePartialDate(v).precision !== 'unknown', 'Write dates as 2015, 2015-06 or 2015-06-30, or leave them empty.');

export const albumEdit = z.object({
  title: z.string().trim().min(1, 'An album needs a title.').max(300),
  type: z.enum(['album', 'ep', 'single', 'compilation', 'mixtape', 'soundtrack', 'live']),
  status: z.enum(['announced', 'released', 'cancelled']),
  date: partialDate,
  availability: z.enum(['', 'for_sale', 'unpurchasable', 'unreleased']),
  preferred_release_id: z.string().max(64),
  genres: z.string().max(500),
  /** The standard edition's label, which is what the album page shows. */
  label: z.string().trim().max(200).optional(),
  /** A Spotify album link or id; empty unlinks. */
  spotify: z.string().trim().max(300).optional(),
});

export const artistEdit = z.object({
  name: z.string().trim().min(1, 'An artist needs a name.').max(200),
  sort_name: z.string().trim().min(1).max(200),
  disambiguation: z.string().trim().max(200),
  kind: z.enum(['', 'person', 'group', 'duo', 'orchestra', 'choir', 'character', 'other']),
  begin: partialDate,
  end: partialDate,
  area: z.string().trim().max(120),
});

type Statement = D1PreparedStatement;

/** A partial date as stored in an override: always these two keys, in this order. */
export const dateValue = (date: string | null | undefined, precision: string | null | undefined) => ({ date: date ?? null, precision: precision ?? 'unknown' });

/**
 * The statements recording one field as set by hand. The first edit keeps
 * what it replaced (original); a later edit that puts that value back
 * removes the mark, so the field is the sources' again.
 */
export function override(userId: string, entityType: string, entityId: string, field: string, value: unknown, original: unknown): Statement[] {
  return [
    env.DB.prepare(
      `INSERT INTO field_override (entity_type, entity_id, field, value_json, original_json, user_id) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (entity_type, entity_id, field)
       DO UPDATE SET value_json = excluded.value_json, user_id = excluded.user_id,
                     original_json = coalesce(field_override.original_json, excluded.original_json),
                     edited_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ).bind(entityType, entityId, field, JSON.stringify(value ?? null), JSON.stringify(original ?? null), userId),
    env.DB.prepare(
      `DELETE FROM field_override WHERE entity_type = ? AND entity_id = ? AND field = ? AND original_json = value_json`,
    ).bind(entityType, entityId, field),
  ];
}

export async function editAlbum(userId: string, id: string, input: z.infer<typeof albumEdit>): Promise<void> {
  const current = await env.DB.prepare(
    `SELECT title, type, status, first_release_date, date_precision, availability, preferred_release_id FROM release_group WHERE id = ?`,
  )
    .bind(id)
    .first<{
      title: string;
      type: string;
      status: string;
      first_release_date: string | null;
      date_precision: string;
      availability: string | null;
      preferred_release_id: string | null;
    }>();
  if (!current) throw new EditError('That album no longer exists.');

  const db = env.DB;
  const statements: Statement[] = [];
  const set = (column: keyof typeof current, value: unknown) =>
    statements.push(
      db.prepare(`UPDATE release_group SET ${column} = ? WHERE id = ?`).bind(value, id),
      ...override(userId, 'release_group', id, column, value, current[column]),
    );

  if (input.title !== current.title) set('title', input.title);
  if (input.type !== current.type) set('type', input.type);
  if (input.status !== current.status) set('status', input.status);
  const availability = input.availability || null;
  if (availability !== current.availability) set('availability', availability);

  const date = parsePartialDate(input.date);
  if (date.date !== current.first_release_date || date.precision !== current.date_precision) {
    statements.push(
      db.prepare(`UPDATE release_group SET first_release_date = ?, date_precision = ? WHERE id = ?`).bind(date.date, date.precision, id),
      ...override(
        userId,
        'release_group',
        id,
        'first_release_date',
        dateValue(date.date, date.precision),
        dateValue(current.first_release_date, current.date_precision),
      ),
    );
  }

  const preferred = input.preferred_release_id || null;
  if (preferred !== current.preferred_release_id) {
    if (preferred) {
      const ok = await db.prepare(`SELECT 1 AS ok FROM release WHERE id = ? AND release_group_id = ?`).bind(preferred, id).first();
      if (!ok) throw new EditError('That edition is not one of this album’s.');
    }
    set('preferred_release_id', preferred);
  }

  // Genres typed here are manual tags: they win over imported ones and are
  // never recomputed. Replacing them is the whole set, not a merge.
  const names = [...new Set(input.genres.split(',').map((g) => g.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
  const existing = (
    await db.prepare(
      `SELECT g.name FROM genre_tag t JOIN genre g ON g.id = t.genre_id
       WHERE t.entity_type = 'release_group' AND t.entity_id = ? AND t.source = 'manual' ORDER BY g.name`,
    )
      .bind(id)
      .all<{ name: string }>()
  ).results.map((r) => r.name);
  if ([...names].sort().join() !== existing.join()) {
    const rows = names.map((name) => ({ name, id: crypto.randomUUID() }));
    statements.push(
      db.prepare(`DELETE FROM genre_tag WHERE entity_type = 'release_group' AND entity_id = ? AND source = 'manual'`).bind(id),
      db.prepare(
        `INSERT INTO genre (id, name) SELECT j.value ->> '$.id', j.value ->> '$.name' FROM json_each(?1) j WHERE true ON CONFLICT DO NOTHING`,
      ).bind(JSON.stringify(rows)),
      db.prepare(
        `INSERT INTO genre_tag (entity_type, entity_id, genre_id, source, weight)
         SELECT 'release_group', ?2, g.id, 'manual', 1 FROM json_each(?1) j JOIN genre g ON g.name = j.value ->> '$.name'
         WHERE true ON CONFLICT DO NOTHING`,
      ).bind(JSON.stringify(rows), id),
    );
  }

  if (input.label !== undefined) {
    const standard = await db
      .prepare(`SELECT r.id, r.label FROM v_release_group_canonical c JOIN release r ON r.id = c.release_id WHERE c.release_group_id = ?`)
      .bind(id)
      .first<{ id: string; label: string | null }>();
    const label = input.label || null;
    if (standard && standard.label !== label) {
      statements.push(
        db.prepare(`UPDATE release SET label = ? WHERE id = ?`).bind(label, standard.id),
        ...override(userId, 'release', standard.id, 'label', label, standard.label),
      );
    }
  }

  if (input.spotify !== undefined) statements.push(...(await spotifyLinkStatements(userId, 'release_group', id, input.spotify)));

  if (statements.length) await db.batch(statements);
}

const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

/**
 * Sets or clears an album's or track's Spotify link by hand, from a pasted
 * link or id. Marked as an override so the automatic linking never puts a
 * cleared or corrected link back.
 */
export async function spotifyLinkStatements(
  userId: string,
  table: 'release_group' | 'recording',
  id: string,
  raw: string,
): Promise<D1PreparedStatement[]> {
  const value = raw.trim();
  const kind = table === 'release_group' ? 'album' : 'track';
  let spotifyId: string | null = null;
  if (value) {
    const fromUrl = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?|spotify:)(album|track)[/:]([A-Za-z0-9]{22})/i.exec(value);
    if (fromUrl) {
      if (fromUrl[1]!.toLowerCase() !== kind) throw new EditError(`That is a Spotify ${fromUrl[1]!.toLowerCase()} link; this needs a ${kind} link.`);
      spotifyId = fromUrl[2]!;
    } else if (SPOTIFY_ID.test(value)) {
      spotifyId = value;
    } else {
      throw new EditError(`That is not a Spotify ${kind} link.`);
    }
  }
  const current = await env.DB.prepare(`SELECT spotify_id FROM ${table} WHERE id = ?`).bind(id).first<{ spotify_id: string | null }>();
  if (!current) throw new EditError('That no longer exists.');
  if (current.spotify_id === spotifyId) return [];
  if (spotifyId) {
    const taken = await env.DB.prepare(`SELECT id FROM ${table} WHERE spotify_id = ? AND id <> ?`).bind(spotifyId, id).first();
    if (taken) throw new EditError(`Another ${kind === 'album' ? 'album' : 'track'} here is already linked to that Spotify ${kind}.`);
  }
  return [
    env.DB.prepare(`UPDATE ${table} SET spotify_id = ? WHERE id = ?`).bind(spotifyId, id),
    ...override(userId, table, id, 'spotify_id', spotifyId, current.spotify_id),
  ];
}

/** Manual genre tags on a track, replacing its others as an album's do. */
export async function editTrackGenres(recordingId: string, raw: string): Promise<void> {
  const names = [...new Set(raw.split(',').map((g) => g.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
  const rows = names.map((name) => ({ name, id: crypto.randomUUID() }));
  const db = env.DB;
  await db.batch([
    db.prepare(`DELETE FROM genre_tag WHERE entity_type = 'recording' AND entity_id = ? AND source = 'manual'`).bind(recordingId),
    db.prepare(`INSERT INTO genre (id, name) SELECT j.value ->> '$.id', j.value ->> '$.name' FROM json_each(?1) j WHERE true ON CONFLICT DO NOTHING`).bind(
      JSON.stringify(rows),
    ),
    db.prepare(
      `INSERT INTO genre_tag (entity_type, entity_id, genre_id, source, weight)
       SELECT 'recording', ?2, g.id, 'manual', 1 FROM json_each(?1) j JOIN genre g ON g.name = j.value ->> '$.name'
       WHERE true ON CONFLICT DO NOTHING`,
    ).bind(JSON.stringify(rows), recordingId),
  ]);
}

/** An existing artist by name or alias, when exactly one answers to it. */
export async function artistByName(name: string): Promise<{ id: string; name: string }> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT a.id, a.name FROM artist a
     LEFT JOIN artist_alias x ON x.artist_id = a.id
     WHERE a.name = ?1 COLLATE NOCASE OR x.name = ?1 COLLATE NOCASE`,
  )
    .bind(name.trim())
    .all<{ id: string; name: string }>();
  if (results.length === 0) throw new EditError(`There is no artist called “${name.trim()}”.`);
  if (results.length > 1) throw new EditError(`More than one artist is called “${name.trim()}”; open the right one and link from there.`);
  return results[0]!;
}

/**
 * Credits an artist as writer on every track of the album's standard
 * edition that has no writer yet: for albums MusicBrainz has no writing
 * credits for. Returns how many tracks gained one.
 */
export async function creditWriter(albumId: string, artistName: string): Promise<number> {
  const writer = await artistByName(artistName);
  const result = await env.DB.prepare(
    `INSERT INTO artist_credit (id, entity_type, entity_id, artist_id, role, position)
     SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-a' ||
            substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
            'recording', t.recording_id, ?2, 'writer', 1
     FROM v_release_group_canonical c
     JOIN track t ON t.release_id = c.release_id
     WHERE c.release_group_id = ?1
       AND NOT EXISTS (SELECT 1 FROM artist_credit w WHERE w.entity_type = 'recording' AND w.entity_id = t.recording_id AND w.role IN (SELECT id FROM credit_role WHERE family = 'writing'))
     ON CONFLICT DO NOTHING`,
  )
    .bind(albumId, writer.id)
    .run();
  return result.meta.changes ?? 0;
}

export async function editArtist(userId: string, id: string, input: z.infer<typeof artistEdit>): Promise<void> {
  const current = await env.DB.prepare(
    `SELECT name, sort_name, disambiguation, kind, begin_date, begin_precision, end_date, end_precision, area FROM artist WHERE id = ?`,
  )
    .bind(id)
    .first<Record<string, string | null>>();
  if (!current) throw new EditError('That artist no longer exists.');

  const db = env.DB;
  const statements: Statement[] = [];
  const set = (column: string, value: string | null) => {
    if ((current[column] ?? null) === value) return;
    statements.push(
      db.prepare(`UPDATE artist SET ${column} = ? WHERE id = ?`).bind(value, id),
      ...override(userId, 'artist', id, column, value, current[column] ?? null),
    );
  };
  set('name', input.name);
  set('sort_name', input.sort_name);
  set('disambiguation', input.disambiguation || null);
  set('kind', input.kind || null);
  set('area', input.area || null);
  for (const [field, raw] of [
    ['begin', input.begin],
    ['end', input.end],
  ] as const) {
    const d = parsePartialDate(raw);
    if (d.date === current[`${field}_date`] && d.precision === current[`${field}_precision`]) continue;
    statements.push(
      db.prepare(`UPDATE artist SET ${field}_date = ?, ${field}_precision = ? WHERE id = ?`).bind(d.date, d.precision, id),
      ...override(
        userId,
        'artist',
        id,
        `${field}_date`,
        dateValue(d.date, d.precision),
        dateValue(current[`${field}_date`], current[`${field}_precision`]),
      ),
    );
  }
  if (statements.length) await db.batch(statements);
}

export async function addAlias(artistId: string, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean || clean.length > 200) throw new EditError('Give the other name.');
  await env.DB.prepare(`INSERT INTO artist_alias (artist_id, name, kind, source) VALUES (?, ?, 'alias', 'manual') ON CONFLICT DO NOTHING`)
    .bind(artistId, clean)
    .run();
}

export async function removeAlias(artistId: string, name: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM artist_alias WHERE artist_id = ? AND name = ?`).bind(artistId, name).run();
}

/**
 * Links two artists: "member of" a group, or "same person as" another
 * record kept apart on purpose. The other artist is named, and must be
 * one artist exactly.
 */
export async function addLink(artistId: string, kind: 'member_of' | 'has_member' | 'same_person', otherName: string): Promise<void> {
  const other = await artistByName(otherName);
  if (other.id === artistId) throw new EditError('An artist cannot be linked to itself.');
  const [from, to, stored] =
    kind === 'has_member' ? [other.id, artistId, 'member_of'] : kind === 'member_of' ? [artistId, other.id, 'member_of'] : [artistId, other.id, 'same_person'];
  await env.DB.prepare(`INSERT INTO artist_link (artist_id, other_id, kind, source) VALUES (?, ?, ?, 'manual') ON CONFLICT DO NOTHING`)
    .bind(from, to, stored)
    .run();
}

export async function removeLink(artistId: string, otherId: string, kind: string): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM artist_link WHERE kind = ?3 AND ((artist_id = ?1 AND other_id = ?2) OR (artist_id = ?2 AND other_id = ?1))`,
  )
    .bind(artistId, otherId, kind)
    .run();
}

export async function setImageHidden(artistId: string, key: string, hidden: boolean): Promise<void> {
  await env.DB.prepare(`UPDATE artist_image SET hidden = ? WHERE artist_id = ? AND key = ?`).bind(hidden ? 1 : 0, artistId, key).run();
}

export const editionEdit = z.object({
  edition: z.string().min(1).max(64),
  edition_title: z.string().trim().min(1, 'An edition needs a title.').max(300),
  edition_date: partialDate,
  label: z.string().trim().max(200),
  format: z.string().trim().max(100),
  note: z.string().trim().max(300).optional(),
});

/**
 * Corrects one edition of an album: its own title, date, label and format.
 * Editions keep their own dates ("The Instrumentals" came out the day
 * before), separate from the album's first release date.
 */
export async function editEdition(userId: string, albumId: string, input: z.infer<typeof editionEdit>): Promise<void> {
  const current = await env.DB.prepare(`SELECT title, date, date_precision, label, format, note FROM release WHERE id = ? AND release_group_id = ?`)
    .bind(input.edition, albumId)
    .first<{ title: string; date: string | null; date_precision: string; label: string | null; format: string | null; note: string | null }>();
  if (!current) throw new EditError('That edition is not one of this album’s.');

  const db = env.DB;
  const id = input.edition;
  const statements: Statement[] = [];
  const set = (column: 'title' | 'label' | 'format' | 'note', value: string | null) => {
    if ((current[column] ?? null) === value) return;
    statements.push(
      db.prepare(`UPDATE release SET ${column} = ? WHERE id = ?`).bind(value, id),
      ...override(userId, 'release', id, column, value, current[column] ?? null),
    );
  };
  set('title', input.edition_title);
  set('label', input.label || null);
  set('format', input.format || null);
  if (input.note !== undefined) set('note', input.note || null);
  const date = parsePartialDate(input.edition_date);
  if (date.date !== current.date || date.precision !== current.date_precision) {
    statements.push(
      db.prepare(`UPDATE release SET date = ?, date_precision = ? WHERE id = ?`).bind(date.date, date.precision, id),
      ...override(userId, 'release', id, 'date', dateValue(date.date, date.precision), dateValue(current.date, current.date_precision)),
    );
  }
  if (statements.length) await db.batch(statements);
}
