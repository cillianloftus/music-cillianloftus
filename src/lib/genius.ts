/**
 * Credits from Genius, for the tracks MusicBrainz has none for, and each
 * track's Genius page, so a track page can link to its lyrics there (the
 * lyrics themselves are never fetched or stored: Genius's API does not
 * offer them and they are not ours to republish). Spotify shows credits in
 * its apps, but its Web API has no credits endpoint, so it cannot be the
 * source.
 *
 * Beyond writers and producers, Genius lists everything else it knows as
 * labelled credits ("Mixing Engineer", "Guitar", "Background Vocals").
 * Those map onto existing roles by label or synonym; a part the library has
 * no role for yet becomes one. Labels that name a company, place or date
 * ("Label", "Recorded At") are skipped.
 *
 * A Genius song is used only when both its title and its primary artist
 * match the track's (ignoring case, accents and "(Ft. …)"), so a cover or a
 * same-named song by someone else is never taken for it.
 *
 * Needs GENIUS_ACCESS_TOKEN (a free client access token from
 * genius.com/api-clients). Without it, nothing here runs.
 */

import { env } from 'cloudflare:workers';
import { credentials } from './connections';
import { addRole, fillCredits, type CreditRole } from './credits';
import { normaliseName, normaliseTitle } from './text';

const API = 'https://api.genius.com';

/** The token, from the GENIUS_ACCESS_TOKEN secret or pasted on /manage/connections. */
export async function geniusToken(): Promise<string | null> {
  return (await credentials('genius'))?.token ?? null;
}

interface Hit {
  result: { id: number; title: string; primary_artist?: { name: string } };
}

/** A song as Genius lists it in another's relationships. */
interface SongSummary {
  title: string;
  url: string;
  primary_artist_names?: string;
  primary_artist?: { name: string };
  release_date_components?: { year: number | null } | null;
}

interface Song extends Partial<SongSummary> {
  url?: string;
  album?: { name: string; url: string } | null;
  /** "samples", "sampled_in", "interpolates", "interpolated_by", and covers, remixes, translations. */
  song_relationships?: { relationship_type: string; songs: SongSummary[] }[];
  writer_artists?: { name: string }[];
  producer_artists?: { name: string }[];
  /** Everything else Genius lists: "Mixing Engineer", "Guitar", "Label"… */
  custom_performances?: { label: string; artists: { name: string }[] }[];
}

/** Genius credit labels that name a company, a place or a date rather than a person's part. */
const NOT_A_PART =
  /\b(label|publisher|copyright|phonographic|distributor|recorded at|mixed at|mastered at|studio|release date|video|a&r|management|marketing|artwork|photograph|design|creative direct)/i;

/** Genius's wording where it differs from a role's own label. */
const SYNONYMS: Record<string, string> = {
  'additional production': 'additional_producer',
  'co-producer': 'co_producer',
  'vocal production': 'vocal_producer',
  vocals: 'lead_vocals',
  'lead vocals': 'lead_vocals',
  programmer: 'programming',
  mixing: 'mixer',
  mastering: 'mastering_engineer',
  engineering: 'engineer',
  recording: 'recording_engineer',
  songwriter: 'writer',
};

/** Where a role new to the library belongs, guessed from its name. */
export function familyOf(label: string): string {
  if (/writ|compos|lyric/i.test(label)) return 'writing';
  if (/produc|programm|remix/i.test(label)) return 'production';
  if (/engineer|mix|master|record/i.test(label)) return 'engineering';
  return 'performance';
}

/** "(Ft. Someone)" and "[Remix]" style tails Genius adds to titles. */
export function geniusTitleKey(title: string): string {
  return normaliseTitle(title.replace(/\s*[([](?:ft|feat|featuring)\.?\s[^)\]]*[)\]]/giu, ''));
}

export interface GeniusFind {
  url: string | null;
  album: { name: string; url: string } | null;
  credits: { role: CreditRole; name: string }[];
  /** What it samples and interpolates, and what samples and interpolates it. */
  links: SongLink[];
}

/** A song named by its Genius page, as a link holds it. */
export interface LinkedSong {
  url: string;
  title: string;
  artist: string;
  year: number | null;
}

/** `song` samples or interpolates `source`. */
export interface SongLink {
  kind: 'samples' | 'interpolates';
  song: LinkedSong;
  source: LinkedSong;
}

const GENIUS_PAGE = /^https:\/\/genius\.com\//;

function linkedSong(s: Partial<SongSummary>): LinkedSong | null {
  const artist = s.primary_artist_names ?? s.primary_artist?.name;
  if (!s.url || !GENIUS_PAGE.test(s.url) || !s.title || !artist) return null;
  return { url: s.url, title: s.title, artist, year: s.release_date_components?.year ?? null };
}

/** Each relationship the song lists as a link, read the one way round: the song that samples, then the one sampled. */
export function songLinks(song: Song): SongLink[] {
  const self = linkedSong(song);
  if (!self) return [];
  const ways: Record<string, { kind: SongLink['kind']; selfUses: boolean }> = {
    samples: { kind: 'samples', selfUses: true },
    sampled_in: { kind: 'samples', selfUses: false },
    interpolates: { kind: 'interpolates', selfUses: true },
    interpolated_by: { kind: 'interpolates', selfUses: false },
  };
  const links: SongLink[] = [];
  for (const relation of song.song_relationships ?? []) {
    const way = ways[relation.relationship_type];
    if (!way) continue;
    for (const other of relation.songs) {
      const them = linkedSong(other);
      if (!them || them.url === self.url) continue;
      links.push(way.selfUses ? { kind: way.kind, song: self, source: them } : { kind: way.kind, song: them, source: self });
    }
  }
  return links;
}

/** Keeps links not held yet; returns how many were new. */
export async function keepSongLinks(links: SongLink[]): Promise<number> {
  if (links.length === 0) return 0;
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO song_link (kind, song_url, song_title, song_artist, song_year, source_url, source_title, source_artist, source_year)
     SELECT l.value ->> 'kind',
            l.value ->> '$.song.url', l.value ->> '$.song.title', l.value ->> '$.song.artist', l.value ->> '$.song.year',
            l.value ->> '$.source.url', l.value ->> '$.source.title', l.value ->> '$.source.artist', l.value ->> '$.source.year'
     FROM json_each(?) l`,
  )
    .bind(JSON.stringify(links))
    .run();
  return result.meta.changes ?? 0;
}

export async function geniusCredits(
  token: string,
  query: { title: string; artists: string[] },
  fetcher: typeof fetch = fetch,
  roleFor: (label: string) => Promise<CreditRole | null> = async () => null,
): Promise<GeniusFind | null> {
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetcher(`${API}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    if (!res.ok) throw new Error(`Genius ${res.status} for ${path}`);
    return ((await res.json()) as { response: T }).response;
  };
  const search = await get<{ hits: Hit[] }>(`/search?q=${encodeURIComponent(`${query.artists[0] ?? ''} ${query.title}`)}`);
  const titleKey = geniusTitleKey(query.title);
  const artistKeys = new Set(query.artists.map(normaliseName));
  const hit = search.hits.find(
    (h) => geniusTitleKey(h.result.title) === titleKey && h.result.primary_artist && artistKeys.has(normaliseName(h.result.primary_artist.name)),
  );
  if (!hit) return null;
  const { song } = await get<{ song: Song }>(`/songs/${hit.result.id}?text_format=plain`);
  const credits: GeniusFind['credits'] = [
    ...(song.writer_artists ?? []).map((a) => ({ role: 'writer', name: a.name })),
    ...(song.producer_artists ?? []).map((a) => ({ role: 'producer', name: a.name })),
  ];
  for (const part of song.custom_performances ?? []) {
    if (NOT_A_PART.test(part.label)) continue;
    const role = await roleFor(part.label);
    if (role) for (const a of part.artists) credits.push({ role, name: a.name });
  }
  const url = song.url && GENIUS_PAGE.test(song.url) ? song.url : null;
  const album = song.album && GENIUS_PAGE.test(song.album.url) ? { name: song.album.name, url: song.album.url } : null;
  return { url, album, credits, links: songLinks(song) };
}

/**
 * A credit_role for a Genius label: an existing role by label or synonym,
 * or a new one named as Genius names it.
 */
async function roleForLabel(label: string): Promise<CreditRole | null> {
  const clean = label.trim();
  if (!clean || clean.length > 60) return null;
  const synonym = SYNONYMS[clean.toLowerCase()];
  if (synonym) return synonym;
  const existing = await env.DB.prepare(`SELECT id FROM credit_role WHERE label = ? COLLATE NOCASE`).bind(clean).first<{ id: string }>();
  if (existing) return existing.id;
  try {
    return await addRole(clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase(), familyOf(clean));
  } catch {
    return null;
  }
}

/** The Genius album page, onto the albums this track is on that share its title. */
async function linkAlbumPage(recordingId: string, album: { name: string; url: string }): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT g.id, g.title FROM track t JOIN release x ON x.id = t.release_id JOIN release_group g ON g.id = x.release_group_id
     WHERE t.recording_id = ? AND g.genius_url IS NULL`,
  )
    .bind(recordingId)
    .all<{ id: string; title: string }>();
  const key = normaliseTitle(album.name);
  for (const g of results) {
    if (normaliseTitle(g.title) === key) await env.DB.prepare(`UPDATE release_group SET genius_url = ? WHERE id = ?`).bind(album.url, g.id).run();
  }
}

/**
 * Looks up tracks with no Genius page yet, on one album or across the
 * library, until the time budget runs out: their credits fill roles they
 * have none in (never a track edited by hand), and their page is kept for
 * the lyrics link. A track looked up once is not looked up again for a
 * month, found or not.
 */
export async function fillCreditsFromGenius({
  albumId,
  budgetMs,
  limit = 40,
  fetcher = fetch,
}: {
  albumId?: string;
  budgetMs: number;
  limit?: number;
  fetcher?: typeof fetch;
}): Promise<{ looked: number; matched: number; added: number }> {
  const token = await geniusToken();
  const report = { looked: 0, matched: 0, added: 0 };
  if (!token) return report;
  const deadline = Date.now() + budgetMs;

  const { results } = await env.DB.prepare(
    `SELECT r.id, r.title,
            (SELECT json_group_array(a.name) FROM (
               SELECT a.name FROM artist_credit c JOIN artist a ON a.id = c.artist_id
               WHERE c.entity_type = 'recording' AND c.entity_id = r.id AND c.role = 'primary' ORDER BY c.position)
             a) AS artists,
            (SELECT json_group_array(x.name) FROM artist_credit c JOIN artist_alias x ON x.artist_id = c.artist_id
             WHERE c.entity_type = 'recording' AND c.entity_id = r.id AND c.role = 'primary') AS aliases
     FROM recording r
     WHERE r.genius_url IS NULL
       AND NOT EXISTS (SELECT 1 FROM lookup_log l WHERE l.source = 'genius' AND l.entity_id = r.id AND l.looked_at > datetime('now', '-30 days'))
       AND (?1 IS NULL OR r.id IN (SELECT t.recording_id FROM release x JOIN track t ON t.release_id = x.id WHERE x.release_group_id = ?1))
     LIMIT ?2`,
  )
    .bind(albumId ?? null, limit)
    .all<{ id: string; title: string; artists: string; aliases: string }>();

  for (const row of results) {
    if (Date.now() > deadline) break;
    report.looked += 1;
    try {
      const found = await geniusCredits(token, { title: row.title, artists: [...JSON.parse(row.artists), ...JSON.parse(row.aliases)] }, fetcher, roleForLabel);
      if (found) {
        report.matched += 1;
        report.added += await fillCredits(row.id, found.credits);
        if (found.url) await env.DB.prepare(`UPDATE recording SET genius_url = ? WHERE id = ? AND genius_url IS NULL`).bind(found.url, row.id).run();
        if (found.album) await linkAlbumPage(row.id, found.album);
        await keepSongLinks(found.links);
        await logLookup('genius-links', row.id, true);
      }
      await logLookup('genius', row.id, found !== null);
    } catch (error) {
      console.warn('Genius lookup failed', row.title, error);
      if (error instanceof Error && /Genius (401|403|429)/.test(error.message)) break;
    }
  }
  if (albumId && Date.now() < deadline) await fillAlbumPage(token, albumId, fetcher).catch((error) => console.warn('Genius album page failed', error));
  return report;
}

async function logLookup(source: 'genius' | 'genius-links', recordingId: string, found: boolean): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO lookup_log (source, entity_id, found) VALUES (?, ?, ?)
     ON CONFLICT (source, entity_id) DO UPDATE SET found = excluded.found, looked_at = excluded.looked_at`,
  )
    .bind(source, recordingId, found ? 1 : 0)
    .run();
}

/**
 * Samples and interpolations for tracks already matched on Genius before
 * links were kept (their page is known, their links not): looked up once
 * each, until the time budget runs out. Newly matched tracks get theirs
 * with their credits.
 */
export async function fillSongLinks({
  budgetMs,
  limit = 60,
  fetcher = fetch,
}: {
  budgetMs: number;
  limit?: number;
  fetcher?: typeof fetch;
}): Promise<{ looked: number; links: number; left: number }> {
  const token = await geniusToken();
  const report = { looked: 0, links: 0, left: 0 };
  if (!token) return report;
  const deadline = Date.now() + budgetMs;
  const waiting = `FROM recording r
     WHERE r.genius_url IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM lookup_log l WHERE l.source = 'genius-links' AND l.entity_id = r.id)`;
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.title, r.genius_url,
            (SELECT json_group_array(a.name) FROM artist_credit c JOIN artist a ON a.id = c.artist_id
             WHERE c.entity_type = 'recording' AND c.entity_id = r.id AND c.role = 'primary') AS artists,
            (SELECT json_group_array(x.name) FROM artist_credit c JOIN artist_alias x ON x.artist_id = c.artist_id
             WHERE c.entity_type = 'recording' AND c.entity_id = r.id AND c.role = 'primary') AS aliases
     ${waiting} LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string; title: string; genius_url: string; artists: string; aliases: string }>();

  for (const row of results) {
    if (Date.now() > deadline) break;
    report.looked += 1;
    try {
      const found = await geniusCredits(token, { title: row.title, artists: [...JSON.parse(row.artists), ...JSON.parse(row.aliases)] }, fetcher);
      // Only the song already taken for this track: a search that now finds another is not it.
      const same = found?.url === row.genius_url;
      if (found && same) report.links += await keepSongLinks(found.links);
      await logLookup('genius-links', row.id, same);
    } catch (error) {
      console.warn('Genius links lookup failed', row.title, error);
      if (error instanceof Error && /Genius (401|403|429)/.test(error.message)) break;
    }
  }
  report.left = (await env.DB.prepare(`SELECT count(*) AS n ${waiting}`).first<{ n: number }>())?.n ?? 0;
  return report;
}

/**
 * An album's Genius page when none is known yet, through one of its tracks
 * (its first, by position): for albums whose tracks were looked up before
 * album pages were kept.
 */
async function fillAlbumPage(token: string, albumId: string, fetcher: typeof fetch): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT r.id, r.title,
            (SELECT json_group_array(a.name) FROM artist_credit c JOIN artist a ON a.id = c.artist_id
             WHERE c.entity_type = 'recording' AND c.entity_id = r.id AND c.role = 'primary') AS artists
     FROM release_group g
     JOIN v_release_group_canonical v ON v.release_group_id = g.id
     JOIN track t ON t.release_id = v.release_id
     JOIN recording r ON r.id = t.recording_id
     WHERE g.id = ? AND g.genius_url IS NULL
     ORDER BY t.disc, t.position LIMIT 1`,
  )
    .bind(albumId)
    .first<{ id: string; title: string; artists: string }>();
  if (!row) return;
  const found = await geniusCredits(token, { title: row.title, artists: JSON.parse(row.artists) }, fetcher);
  if (found?.album) await linkAlbumPage(row.id, found.album);
}
