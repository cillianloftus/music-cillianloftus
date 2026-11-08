/**
 * Editions added by hand: a version of an album no database has (a cut
 * pulled from streaming and put back changed, a tour pressing). Its tracks
 * are copied from another edition or pasted; pasted titles are matched to
 * the songs already on the album, ignoring case and punctuation, so the
 * edition shares their recordings and ratings, and its own styling of a
 * title is kept as the title on that release. Titles that match nothing
 * become new recordings by the album's artists.
 */

import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { artistForCredit } from './credits';
import { parsePartialDate } from './dates';
import { EditError } from './edits';
import { MAX_TRACKS, parseTracklist } from './import/manual';
import { normaliseTitle } from './text';

const partialDate = z
  .string()
  .trim()
  .max(10)
  .refine((v) => v === '' || parsePartialDate(v).precision !== 'unknown', 'Write dates as 2023, 2023-06 or 2023-06-30, or leave them empty.');

export const newEdition = z.object({
  title: z.string().trim().min(1, 'An edition needs a title.').max(300),
  date: partialDate,
  label: z.string().trim().max(200),
  format: z.string().trim().max(100),
  note: z.string().trim().max(300),
  /** Copy this edition's tracks… */
  copy_from: z.string().max(64),
  /** …or these, one per line. */
  tracklist: z.string().max(20_000),
});

export interface CreatedEdition {
  releaseId: string;
  matched: number;
  created: number;
}

export async function createEdition(albumId: string, input: z.infer<typeof newEdition>): Promise<CreatedEdition> {
  const db = env.DB;
  const album = await db.prepare(`SELECT id FROM release_group WHERE id = ?`).bind(albumId).first();
  if (!album) throw new EditError('That album no longer exists.');
  const date = parsePartialDate(input.date);
  const releaseId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO release (id, release_group_id, title, date, date_precision, label, format, note, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
    ).bind(releaseId, albumId, input.title, date.date, date.precision, input.label || null, input.format || null, input.note || null),
  ];

  let matched = 0;
  let created = 0;

  if (input.tracklist.trim()) {
    const parsed = parseTracklist(input.tracklist);
    if (parsed.length === 0) throw new EditError('No tracks could be read from that list.');
    if (parsed.length > MAX_TRACKS) throw new EditError(`At most ${MAX_TRACKS} tracks.`);

    // The album's songs, by normalised title (recording title or any title on a release).
    const { results } = await db
      .prepare(
        `SELECT DISTINCT r.id, r.title, t.title_on_release FROM release x
         JOIN track t ON t.release_id = x.id JOIN recording r ON r.id = t.recording_id
         WHERE x.release_group_id = ?`,
      )
      .bind(albumId)
      .all<{ id: string; title: string; title_on_release: string | null }>();
    const known = new Map<string, { id: string; title: string }>();
    for (const r of results) {
      for (const t of [r.title, r.title_on_release]) if (t && !known.has(normaliseTitle(t))) known.set(normaliseTitle(t), { id: r.id, title: r.title });
    }
    const primaries = (
      await db
        .prepare(
          `SELECT artist_id, position, join_phrase, credited_as FROM artist_credit
           WHERE entity_type = 'release_group' AND entity_id = ? AND role = 'primary' ORDER BY position`,
        )
        .bind(albumId)
        .all<{ artist_id: string; position: number; join_phrase: string; credited_as: string | null }>()
    ).results;

    for (const t of parsed) {
      const hit = known.get(normaliseTitle(t.title));
      let recordingId: string;
      if (hit) {
        recordingId = hit.id;
        matched += 1;
      } else {
        recordingId = crypto.randomUUID();
        created += 1;
        statements.push(
          db.prepare(`INSERT INTO recording (id, title, length_ms, source) VALUES (?, ?, ?, 'manual')`).bind(recordingId, t.title, t.length_ms),
          ...primaries.map((p) =>
            db.prepare(
              `INSERT INTO artist_credit (id, entity_type, entity_id, artist_id, role, position, join_phrase, credited_as)
               VALUES (?, 'recording', ?, ?, 'primary', ?, ?, ?)`,
            ).bind(crypto.randomUUID(), recordingId, p.artist_id, p.position, t.featured.length && p === primaries.at(-1) ? ' feat. ' : p.join_phrase, p.credited_as),
          ),
        );
        let position = 0;
        for (const name of t.featured) {
          const guest = await artistForCredit(name, { create: true });
          statements.push(
            db.prepare(
              `INSERT INTO artist_credit (id, entity_type, entity_id, artist_id, role, position) VALUES (?, 'recording', ?, ?, 'featured', ?) ON CONFLICT DO NOTHING`,
            ).bind(crypto.randomUUID(), recordingId, guest.id, ++position),
          );
        }
        known.set(normaliseTitle(t.title), { id: recordingId, title: t.title });
      }
      const styled = hit && hit.title !== t.title ? t.title : null;
      statements.push(
        db.prepare(`INSERT INTO track (id, release_id, recording_id, disc, position, title_on_release) VALUES (?, ?, ?, ?, ?, ?)`).bind(
          crypto.randomUUID(),
          releaseId,
          recordingId,
          t.disc,
          t.position,
          styled,
        ),
      );
    }
  } else {
    const source = input.copy_from
      ? await db.prepare(`SELECT id FROM release WHERE id = ? AND release_group_id = ?`).bind(input.copy_from, albumId).first<{ id: string }>()
      : await db.prepare(`SELECT release_id AS id FROM v_release_group_canonical WHERE release_group_id = ?`).bind(albumId).first<{ id: string }>();
    if (!source) throw new EditError('Choose an edition to copy, or paste the tracklist.');
    statements.push(
      db.prepare(
        `INSERT INTO track (id, release_id, recording_id, disc, position, title_on_release)
         SELECT lower(hex(randomblob(16))), ?1, recording_id, disc, position, title_on_release FROM track WHERE release_id = ?2`,
      ).bind(releaseId, source.id),
    );
    matched = (await db.prepare(`SELECT count(*) AS n FROM track WHERE release_id = ?`).bind(source.id).first<{ n: number }>())?.n ?? 0;
  }

  await db.batch(statements);
  return { releaseId, matched, created };
}

/**
 * Words that mark an edition rather than the album itself. The same list as
 * v_release_group_canonical (migration 0036): a plainly titled edition is
 * the standard one before any "Deluxe" or "Special Edition", whatever their
 * dates. Substring matches, as the view's GLOBs are, so both always agree.
 */
const EDITION_MARKS = ['deluxe', 'special', 'expanded', 'anniversary', 'remaster', 'bonus', 'edition', 'collector'];

export const isEditionTitle = (title: string) => {
  const lower = title.toLowerCase();
  return EDITION_MARKS.some((mark) => lower.includes(mark));
};
