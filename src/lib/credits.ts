/**
 * A track's credits, by hand and from outside sources.
 *
 * Editing a track's credits marks them as Cillian's (a field_override on
 * the recording, field "credits"): from then on imports and lookups leave
 * that track's credits alone, so a removed credit never comes back. Until
 * then, sources only add credits in roles the track has none of.
 *
 * Titles keep their stylisation. "dustcutter" and "DUSTCUTTER" are the
 * same song written two ways on purpose; matching ignores case, storage
 * never changes it.
 */

import { env } from 'cloudflare:workers';
import { EditError, override } from './edits';
import { normaliseName } from './text';

/** A credit_role id: built in, or added from the app (migration 0018). */
export type CreditRole = string;

export const ROLE_FAMILIES = {
  artist: 'Artists',
  writing: 'Writing',
  production: 'Production',
  engineering: 'Engineering',
  performance: 'Performance',
  other: 'Other',
} as const;
export type RoleFamily = keyof typeof ROLE_FAMILIES;

export interface Role {
  id: string;
  label: string;
  family: RoleFamily;
  /** Set for the roles listed first everywhere, in this order. */
  key_order: number | null;
  builtin: number;
  /** How many credits use it. */
  uses: number;
}

/**
 * Every role, key ones first. How many credits use each is counted only
 * when asked (the roles page): it reads every credit once, where a count
 * per role read them all once per role, about twelve million rows, on every
 * edit page that only needed the names.
 */
export async function creditRoles({ withUses = false } = {}): Promise<Role[]> {
  const { results } = await env.DB.prepare(
    withUses
      ? `SELECT r.id, r.label, r.family, r.key_order, r.builtin, coalesce(u.uses, 0) AS uses
         FROM credit_role r LEFT JOIN (SELECT role, count(*) AS uses FROM artist_credit GROUP BY role) u ON u.role = r.id
         ORDER BY r.key_order IS NULL, r.key_order, r.position, r.label`
      : `SELECT r.id, r.label, r.family, r.key_order, r.builtin, 0 AS uses
         FROM credit_role r ORDER BY r.key_order IS NULL, r.key_order, r.position, r.label`,
  ).all<Role>();
  return results;
}

/** How many credits use each of these roles (an index lookup each). */
export async function roleUses(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const { results } = await env.DB.prepare(
    `SELECT role, count(*) AS uses FROM artist_credit WHERE role IN (SELECT value FROM json_each(?)) GROUP BY role`,
  )
    .bind(JSON.stringify(ids))
    .all<{ role: string; uses: number }>();
  return new Map(results.map((r) => [r.role, r.uses]));
}

/**
 * A new kind of credit, named as a sleeve would ("Vocal Arrangement").
 * Its id is made from the name; adding one that exists is refused.
 */
export async function addRole(label: string, family: string): Promise<string> {
  const clean = label.trim().replace(/\s+/g, ' ');
  if (!clean || clean.length > 60) throw new EditError('Name the role.');
  if (!Object.hasOwn(ROLE_FAMILIES, family)) throw new EditError('Choose what kind of role it is.');
  const id = clean
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!id) throw new EditError('Give the role a name with letters in it.');
  const clash = await env.DB.prepare(`SELECT label FROM credit_role WHERE id = ? OR label = ? COLLATE NOCASE`).bind(id, clean).first<{ label: string }>();
  if (clash) throw new EditError(`There is already a role called “${clash.label}”.`);
  await env.DB.prepare(
    `INSERT INTO credit_role (id, label, family, position)
     VALUES (?1, ?2, ?3, coalesce((SELECT max(position) FROM credit_role WHERE family = ?3), 90) + 1)`,
  )
    .bind(id, clean, family)
    .run();
  return id;
}

/** Removes an added role nobody is credited with. Built-in roles stay. */
export async function removeRole(id: string): Promise<void> {
  const role = await env.DB.prepare(`SELECT builtin, (SELECT count(*) FROM artist_credit WHERE role = ?1) AS uses FROM credit_role WHERE id = ?1`)
    .bind(id)
    .first<{ builtin: number; uses: number }>();
  if (!role) throw new EditError('That role is already gone.');
  if (role.builtin) throw new EditError('Built-in roles cannot be removed.');
  if (role.uses > 0) throw new EditError(`It is still used by ${role.uses} ${role.uses === 1 ? 'credit' : 'credits'}.`);
  await env.DB.prepare(`DELETE FROM credit_role WHERE id = ?`).bind(id).run();
}

/** How roles are grouped for display: key ones first, then by kind. */
export const CREDIT_GROUPS: [string, string][] = [['key', 'Key credits'], ...(Object.entries(ROLE_FAMILIES) as [string, string][])];

/**
 * Splits anything carrying a role's family and key_order into display
 * groups: the key roles first (in their chosen order), then each family in
 * turn, keeping the order the items came in. Empty groups are dropped.
 */
export function groupCredits<T>(items: T[], roleOf: (item: T) => { family: string; key_order: number | null }): { key: string; name: string; items: T[] }[] {
  return CREDIT_GROUPS.map(([key, name]) => ({
    key,
    name,
    items: items
      .filter((item) => (roleOf(item).key_order != null ? 'key' : roleOf(item).family) === key)
      .sort((a, b) => (key === 'key' ? (roleOf(a).key_order ?? 0) - (roleOf(b).key_order ?? 0) : 0)),
  })).filter((g) => g.items.length > 0);
}

/** Marks a role key (at the end of the key list) or not. */
export async function setKeyRole(id: string, key: boolean): Promise<void> {
  await env.DB.prepare(
    key
      ? `UPDATE credit_role SET key_order = coalesce((SELECT max(key_order) FROM credit_role), 0) + 1 WHERE id = ?1 AND key_order IS NULL`
      : `UPDATE credit_role SET key_order = NULL WHERE id = ?1`,
  )
    .bind(id)
    .run();
  await renumberKeys();
}

/** Moves a key role one place up (-1) or down (1). */
export async function moveKeyRole(id: string, by: -1 | 1): Promise<void> {
  const { results } = await env.DB.prepare(`SELECT id FROM credit_role WHERE key_order IS NOT NULL ORDER BY key_order`).all<{ id: string }>();
  const ids = results.map((r) => r.id);
  const i = ids.indexOf(id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  await env.DB.batch(ids.map((rid, n) => env.DB.prepare(`UPDATE credit_role SET key_order = ? WHERE id = ?`).bind(n + 1, rid)));
}

async function renumberKeys(): Promise<void> {
  const { results } = await env.DB.prepare(`SELECT id FROM credit_role WHERE key_order IS NOT NULL ORDER BY key_order`).all<{ id: string }>();
  if (results.length) await env.DB.batch(results.map((r, n) => env.DB.prepare(`UPDATE credit_role SET key_order = ? WHERE id = ?`).bind(n + 1, r.id)));
}

/** Renames a role, or moves it to another family. */
export async function editRole(id: string, label: string, family: string): Promise<void> {
  const clean = label.trim().replace(/\s+/g, ' ');
  if (!clean || clean.length > 60) throw new EditError('Name the role.');
  if (!Object.hasOwn(ROLE_FAMILIES, family)) throw new EditError('Choose what kind of role it is.');
  const clash = await env.DB.prepare(`SELECT 1 AS yes FROM credit_role WHERE label = ? COLLATE NOCASE AND id <> ?`).bind(clean, id).first();
  if (clash) throw new EditError(`There is already a role called “${clean}”.`);
  await env.DB.prepare(`UPDATE credit_role SET label = ?, family = ? WHERE id = ?`).bind(clean, family, id).run();
}

export interface CreditRow {
  id: string;
  role: CreditRole;
  role_label: string;
  family: RoleFamily;
  key_order: number | null;
  artist_id: string;
  name: string;
  credited_as: string | null;
  position: number;
}

/** What credits can be edited on: a track, or an album as a whole. */
export type CreditTarget = 'recording' | 'release_group';
const NOUN: Record<CreditTarget, string> = { recording: 'track', release_group: 'album' };

export async function recordingCredits(id: string, entity: CreditTarget = 'recording'): Promise<CreditRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.role, r.label AS role_label, r.family, r.key_order, c.artist_id, a.name, c.credited_as, c.position
     FROM artist_credit c JOIN artist a ON a.id = c.artist_id JOIN credit_role r ON r.id = c.role
     WHERE c.entity_type = ?2 AND c.entity_id = ?1
     ORDER BY r.family <> 'artist', r.key_order IS NULL, r.key_order, r.position, r.label, c.position, a.sort_name`,
  )
    .bind(id, entity)
    .all<CreditRow>();
  return results;
}

export async function creditsEditedByHand(id: string, entity: CreditTarget = 'recording'): Promise<boolean> {
  return Boolean(
    await env.DB.prepare(`SELECT 1 AS yes FROM field_override WHERE entity_type = ? AND entity_id = ? AND field = 'credits'`)
      .bind(entity, id)
      .first(),
  );
}

/** A track's or album's credits as one comparable value: who, in what role, in what order. */
export async function creditSnapshot(id: string, entity: CreditTarget): Promise<CreditSnapshot> {
  const { results } = await env.DB.prepare(
    `SELECT artist_id, role, position, credited_as, join_phrase FROM artist_credit
     WHERE entity_type = ? AND entity_id = ? ORDER BY role, position, artist_id`,
  )
    .bind(entity, id)
    .all<CreditSnapshot[number]>();
  return results.map((r) => ({ artist_id: r.artist_id, role: r.role, position: r.position, credited_as: r.credited_as ?? null, join_phrase: r.join_phrase }));
}

export type CreditSnapshot = { artist_id: string; role: string; position: number; credited_as: string | null; join_phrase: string }[];

/**
 * Marks credits as edited, keeping the set as it was before the first edit;
 * once they match that set again, the mark goes.
 */
async function markCredits(userId: string, id: string, entity: CreditTarget, before: CreditSnapshot): Promise<void> {
  const after = await creditSnapshot(id, entity);
  await env.DB.batch(override(userId, entity, id, 'credits', after, before));
}

/**
 * The artist answering to a name, by name or alias, ignoring case and
 * accents. Several matches is a question for a person, so it is refused;
 * none creates the artist when asked to.
 */
export async function artistForCredit(name: string, { create }: { create: boolean }): Promise<{ id: string; created: boolean }> {
  const clean = name.trim();
  if (!clean || clean.length > 200) throw new EditError('Give the artist’s name.');
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT a.id, a.name FROM artist a LEFT JOIN artist_alias x ON x.artist_id = a.id
     WHERE a.name = ?1 COLLATE NOCASE OR x.name = ?1 COLLATE NOCASE`,
  )
    .bind(clean)
    .all<{ id: string; name: string }>();
  let matches = results;
  if (matches.length === 0) {
    // Accents and punctuation: "Beyonce" finds "Beyoncé".
    const key = normaliseName(clean);
    const all = await env.DB.prepare(`SELECT id, name FROM artist`).all<{ id: string; name: string }>();
    matches = all.results.filter((a) => normaliseName(a.name) === key);
  }
  if (matches.length > 1) throw new EditError(`More than one artist is called “${clean}”. Give them distinct names first.`);
  if (matches.length === 1) return { id: matches[0]!.id, created: false };
  if (!create) throw new EditError(`There is no artist called “${clean}”.`);
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO artist (id, name, sort_name, source) VALUES (?, ?, ?, 'manual')`).bind(id, clean, clean).run();
  return { id, created: true };
}

export async function addCredit(
  userId: string,
  id: string,
  input: { role: string; name: string; credited_as?: string },
  entity: CreditTarget = 'recording',
): Promise<{ created: boolean }> {
  const known = await env.DB.prepare(`SELECT family FROM credit_role WHERE id = ?`).bind(input.role).first<{ family: string }>();
  if (!known) throw new EditError('Choose what they did.');
  if (entity === 'release_group' && known.family !== 'artist') {
    throw new EditError('An album’s writers, producers and so on come from its tracks. Credit them there, one track or many at once.');
  }
  const exists = await env.DB.prepare(`SELECT 1 AS yes FROM ${entity} WHERE id = ?`).bind(id).first();
  if (!exists) throw new EditError(`That ${NOUN[entity]} no longer exists.`);
  const artist = await artistForCredit(input.name, { create: true });
  const creditedAs = input.credited_as?.trim() || null;
  const already = await env.DB.prepare(`SELECT 1 AS yes FROM artist_credit WHERE entity_type = ? AND entity_id = ? AND artist_id = ? AND role = ?`)
    .bind(entity, id, artist.id, input.role)
    .first();
  if (already) throw new EditError('They already have that credit.');
  const before = await creditSnapshot(id, entity);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO artist_credit (id, entity_type, entity_id, artist_id, role, position, credited_as, join_phrase)
       SELECT ?1, ?6, ?2, ?3, ?4,
              coalesce((SELECT max(position) FROM artist_credit WHERE entity_type = ?6 AND entity_id = ?2 AND role = ?4), 0) + 1,
              ?5, ''
       WHERE true
       ON CONFLICT DO NOTHING`,
    ).bind(crypto.randomUUID(), id, artist.id, input.role, creditedAs, entity),
  ]);
  await fixJoinPhrases(id, entity);
  await markCredits(userId, id, entity, before);
  return { created: artist.created };
}

export async function removeCredit(userId: string, id: string, creditId: string, entity: CreditTarget = 'recording'): Promise<void> {
  const credit = await env.DB.prepare(`SELECT role FROM artist_credit WHERE id = ? AND entity_type = ? AND entity_id = ?`)
    .bind(creditId, entity, id)
    .first<{ role: string }>();
  if (!credit) throw new EditError('That credit is already gone.');
  if (credit.role === 'primary') {
    const primaries = await env.DB.prepare(`SELECT count(*) AS n FROM artist_credit WHERE entity_type = ? AND entity_id = ? AND role = 'primary'`)
      .bind(entity, id)
      .first<{ n: number }>();
    if ((primaries?.n ?? 0) <= 1) throw new EditError(`A ${NOUN[entity]} needs at least one artist. Add the right one before removing this.`);
  }
  const before = await creditSnapshot(id, entity);
  await env.DB.prepare(`DELETE FROM artist_credit WHERE id = ?`).bind(creditId).run();
  await fixJoinPhrases(id, entity);
  await markCredits(userId, id, entity, before);
}

/**
 * Keeps the displayed artist line readable after an edit: primaries joined
 * with ", " and " & ", in position order. Only primaries are shown that way.
 */
async function fixJoinPhrases(id: string, entity: CreditTarget): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM artist_credit WHERE entity_type = ? AND entity_id = ? AND role = 'primary' ORDER BY position, id`,
  )
    .bind(entity, id)
    .all<{ id: string }>();
  const n = results.length;
  if (n === 0) return;
  await env.DB.batch(
    results.map((r, i) =>
      env.DB.prepare(`UPDATE artist_credit SET position = ?, join_phrase = ? WHERE id = ?`).bind(i + 1, i === n - 1 ? '' : i === n - 2 ? ' & ' : ', ', r.id),
    ),
  );
}

/** Restyles a track's title, which wins over every later import. */
export async function editTrackTitle(userId: string, recordingId: string, title: string): Promise<void> {
  const clean = title.trim();
  if (!clean || clean.length > 300) throw new EditError('A track needs a title.');
  const current = await env.DB.prepare(`SELECT title FROM recording WHERE id = ?`).bind(recordingId).first<{ title: string }>();
  if (!current) throw new EditError('That track no longer exists.');
  if (current.title === clean) return;
  await env.DB.batch([
    env.DB.prepare(`UPDATE recording SET title = ? WHERE id = ?`).bind(clean, recordingId),
    ...override(userId, 'recording', recordingId, 'title', clean, current.title),
  ]);
}

/**
 * Credits found by a lookup, added where the track has nobody in that role
 * and its credits have not been edited by hand. Artists new to the library
 * are created. Returns how many credits were added.
 */
export async function fillCredits(recordingId: string, found: { role: CreditRole; name: string }[]): Promise<number> {
  if (found.length === 0 || (await creditsEditedByHand(recordingId))) return 0;
  const { results } = await env.DB.prepare(`SELECT DISTINCT role FROM artist_credit WHERE entity_type = 'recording' AND entity_id = ?`)
    .bind(recordingId)
    .all<{ role: string }>();
  const filled = new Set(results.map((r) => r.role));
  let added = 0;
  const positions = new Map<string, number>();
  for (const credit of found) {
    if (filled.has(credit.role)) continue;
    let artist;
    try {
      artist = await artistForCredit(credit.name, { create: true });
    } catch {
      continue; // An ambiguous name is skipped rather than guessed.
    }
    const position = (positions.get(credit.role) ?? 0) + 1;
    const result = await env.DB.prepare(
      `INSERT INTO artist_credit (id, entity_type, entity_id, artist_id, role, position) VALUES (?, 'recording', ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
      .bind(crypto.randomUUID(), recordingId, artist.id, credit.role, position)
      .run();
    if ((result.meta.changes ?? 0) > 0) {
      positions.set(credit.role, position);
      added += 1;
    }
  }
  return added;
}

/**
 * One credit across many tracks of an album at once: added where missing,
 * or taken off where present. Each track touched counts as edited by hand.
 * Returns how many tracks changed.
 */
export async function batchCredit(
  userId: string,
  albumId: string,
  input: { recordingIds: string[]; role: string; name: string; mode: 'add' | 'remove' },
): Promise<number> {
  if (input.recordingIds.length === 0) throw new EditError('Tick at least one track.');
  const known = await env.DB.prepare(`SELECT 1 AS yes FROM credit_role WHERE id = ?`).bind(input.role).first();
  if (!known) throw new EditError('Choose what they did.');
  // Only tracks that are on this album.
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT t.recording_id AS id FROM release x JOIN track t ON t.release_id = x.id
     WHERE x.release_group_id = ?1 AND t.recording_id IN (SELECT value FROM json_each(?2))`,
  )
    .bind(albumId, JSON.stringify(input.recordingIds))
    .all<{ id: string }>();
  const ids = results.map((r) => r.id);
  const artist = await artistForCredit(input.name, { create: input.mode === 'add' });
  let changed = 0;
  for (const id of ids) {
    const has = await env.DB.prepare(`SELECT id FROM artist_credit WHERE entity_type = 'recording' AND entity_id = ? AND artist_id = ? AND role = ?`)
      .bind(id, artist.id, input.role)
      .first<{ id: string }>();
    if (input.mode === 'add' && !has) {
      await addCredit(userId, id, { role: input.role, name: input.name });
      changed += 1;
    } else if (input.mode === 'remove' && has) {
      try {
        await removeCredit(userId, id, has.id);
        changed += 1;
      } catch (error) {
        if (!(error instanceof EditError)) throw error; // The last artist on a track stays.
      }
    }
  }
  return changed;
}
