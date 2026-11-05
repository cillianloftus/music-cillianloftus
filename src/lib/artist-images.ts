/**
 * Pictures of artists, stored in R2 with the credit each needs:
 *   - Wikimedia Commons, found through Wikidata: the item's image (P18) and
 *     a few from its Commons category (P373). Commons licences require
 *     attribution, so author, licence and source are kept and shown.
 *   - Spotify's artist picture, through the owner's authorisation.
 * Missing sources are skipped; nothing here is required for an artist.
 */

import { looksBlank } from './image-size';
import { credentials } from './connections';
import { geniusToken } from './genius';
import { fanartFor } from './sources/fanart';
import { normaliseName } from './text';
import { env } from 'cloudflare:workers';
import { ownerId } from './auth/user';
import { spotifyFor } from './spotify/client';

const USER_AGENT = 'music-cillianloftus/0.1 ( https://music.cillianloftus.com )';
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
const WIDTH = 800;
const MAX_IMAGES = 7;

interface Candidate {
  url: string;
  source: 'wikimedia' | 'spotify' | 'deezer' | 'genius' | 'fanart';
  source_url: string | null;
  credit: string | null;
  licence: string | null;
  width: number | null;
  height: number | null;
}

const fetchJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).hostname}`);
  return (await response.json()) as T;
};

/** Plain text from Commons' HTML metadata ("<a ...>Jane Doe</a>" → "Jane Doe"). */
export const plainText = (html: string | undefined | null) =>
  html
    ? html
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim() || null
    : null;

interface ImageInfo {
  thumburl?: string;
  thumbwidth?: number;
  thumbheight?: number;
  descriptionurl?: string;
  mime?: string;
  extmetadata?: Record<string, { value?: string }>;
}

/** Commons file pages to candidates: a sized thumbnail, its author and licence. */
async function commonsFiles(titles: string[]): Promise<Candidate[]> {
  if (titles.length === 0) return [];
  const params = new URLSearchParams({
    action: 'query',
    titles: titles.join('|'),
    prop: 'imageinfo',
    iiprop: 'url|size|mime|extmetadata',
    iiurlwidth: String(WIDTH),
    format: 'json',
    origin: '*',
  });
  const data = await fetchJson<{ query?: { pages?: Record<string, { title: string; imageinfo?: ImageInfo[] }> } }>(`${COMMONS}?${params}`);
  const byTitle = new Map(Object.values(data.query?.pages ?? {}).map((p) => [p.title, p.imageinfo?.[0]]));
  return titles.flatMap((title) => {
    const info = byTitle.get(title);
    if (!info?.thumburl || !/^image\/(jpeg|png|webp)$/.test(info.mime ?? '')) return [];
    const meta = info.extmetadata ?? {};
    return [
      {
        url: info.thumburl,
        source: 'wikimedia' as const,
        source_url: info.descriptionurl ?? null,
        credit: plainText(meta.Artist?.value),
        licence: plainText(meta.LicenseShortName?.value),
        width: info.thumbwidth ?? null,
        height: info.thumbheight ?? null,
      },
    ];
  });
}

/** The Wikidata item's image and up to a few more from its Commons category. */
async function wikimediaCandidates(wikidataId: string): Promise<Candidate[]> {
  const entity = await fetchJson<{
    entities: Record<string, { claims?: Record<string, { mainsnak?: { datavalue?: { value?: unknown } } }[]> }>;
  }>(`https://www.wikidata.org/wiki/Special:EntityData/${wikidataId}.json`);
  const claims = entity.entities[wikidataId]?.claims ?? {};
  const values = (property: string) =>
    (claims[property] ?? []).map((c) => c.mainsnak?.datavalue?.value).filter((v): v is string => typeof v === 'string');

  const files = values('P18').map((f) => `File:${f}`);
  const category = values('P373')[0];
  if (category && files.length < MAX_IMAGES) {
    const params = new URLSearchParams({
      action: 'query',
      list: 'categorymembers',
      cmtitle: `Category:${category}`,
      cmtype: 'file',
      cmlimit: '12',
      format: 'json',
      origin: '*',
    });
    const members = await fetchJson<{ query?: { categorymembers?: { title: string }[] } }>(`${COMMONS}?${params}`).catch(() => null);
    for (const m of members?.query?.categorymembers ?? []) {
      // Photographs only: logos, signatures and audio are not pictures of the artist.
      if (/\.(jpe?g)$/i.test(m.title) && !/logo|signature|autograph/i.test(m.title) && !files.includes(m.title)) files.push(m.title);
      if (files.length >= MAX_IMAGES) break;
    }
  }
  return commonsFiles(files.slice(0, MAX_IMAGES));
}

async function spotifyCandidate(spotifyId: string): Promise<Candidate | null> {
  const owner = await ownerId();
  if (!owner) return null;
  const artist = await spotifyFor(owner).get<{ images?: { url: string; width: number | null; height: number | null }[]; external_urls?: { spotify?: string } }>(
    `/artists/${spotifyId}`,
  );
  const image = [...(artist.images ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  return image
    ? { url: image.url, source: 'spotify', source_url: artist.external_urls?.spotify ?? null, credit: 'Spotify', licence: null, width: image.width, height: image.height }
    : null;
}

/**
 * Deezer's picture of the artist, found by name (ignoring case and accents)
 * and only when exactly one artist of that name answers, so a namesake's
 * face is never taken. Deezer's blank placeholder is skipped.
 */
async function deezerCandidate(name: string): Promise<Candidate | null> {
  const res = await fetch(`https://api.deezer.com/search/artist?${new URLSearchParams({ q: name, limit: '10' })}`);
  if (!res.ok) return null;
  const { data } = (await res.json()) as { data?: { name: string; link: string; picture_xl?: string }[] };
  const matches = (data ?? []).filter((a) => normaliseName(a.name) === normaliseName(name));
  const hit = matches.length === 1 ? matches[0]! : null;
  if (!hit?.picture_xl || /\/artist\/\//.test(hit.picture_xl)) return null;
  return { url: hit.picture_xl, source: 'deezer', source_url: hit.link, credit: 'Deezer', licence: null, width: 1000, height: 1000 };
}

/**
 * Genius's picture of the artist, from a search on their name, when the
 * song it finds is theirs (same normalised name). Needs the Genius token;
 * Genius's default avatar is skipped.
 */
async function geniusCandidate(name: string): Promise<Candidate | null> {
  const token = await geniusToken();
  if (!token) return null;
  const res = await fetch(`https://api.genius.com/search?${new URLSearchParams({ q: name })}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { response?: { hits?: { result: { primary_artist?: { name: string; image_url?: string; url?: string } } }[] } };
  const artist = body.response?.hits?.map((h) => h.result.primary_artist).find((a) => a && normaliseName(a.name) === normaliseName(name));
  if (!artist?.image_url || /default_avatar|default_cover/i.test(artist.image_url)) return null;
  return { url: artist.image_url, source: 'genius', source_url: artist.url ?? null, credit: 'Genius', licence: null, width: null, height: null };
}

/**
 * fanart.tv's best-liked portraits (square, 1000px), by MusicBrainz id. Needs
 * its key; without one, nothing.
 */
async function fanartCandidates(mbid: string): Promise<Candidate[]> {
  const creds = await credentials('fanarttv');
  if (!creds) return [];
  const art = await fanartFor(creds.api_key!, mbid);
  return (art?.portraits ?? []).slice(0, 2).map((p) => ({
    url: p.url,
    source: 'fanart' as const,
    source_url: art!.page,
    credit: 'fanart.tv',
    licence: null,
    width: 1000,
    height: 1000,
  }));
}

/** A stable key per source picture, so fetching again adds nothing twice. */
async function keyFor(artistId: string, url: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  const hex = [...new Uint8Array(hash)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `art/artist/${artistId}/${hex}.jpg`;
}

/**
 * Puts an artist's pictures best first: official portraits (Spotify,
 * Deezer) ahead of Genius, then Wikimedia, sharper ahead of smaller, and
 * anything under 400 px last. A picture Cillian put first stays first.
 */
export async function rankArtistImages(artistId: string): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT key, source, width, height, position FROM artist_image WHERE artist_id = ?`,
  )
    .bind(artistId)
    .all<{ key: string; source: string; width: number | null; height: number | null; position: number }>();
  const chosen = await env.DB.prepare(
    `SELECT value_json FROM field_override WHERE entity_type = 'artist' AND entity_id = ? AND field = 'first_image'`,
  )
    .bind(artistId)
    .first<{ value_json: string }>();
  const first = chosen ? (JSON.parse(chosen.value_json) as string) : null;
  const order = await env.DB.prepare(
    `SELECT value_json FROM field_override WHERE entity_type = 'artist' AND entity_id = ? AND field = 'image_order'`,
  )
    .bind(artistId)
    .first<{ value_json: string }>();
  const placed = order ? (JSON.parse(order.value_json) as string[]) : [];
  // fanart.tv's are picked by people for exactly this: first among the found.
  const weight: Record<string, number> = { manual: 5, fanart: 4.5, spotify: 4, deezer: 3.5, genius: 2.5, wikimedia: 1 };
  const score = (r: (typeof results)[number]) => {
    const side = Math.min(r.width ?? 640, r.height ?? r.width ?? 640);
    return (r.key === first ? 100 : 0) + (weight[r.source] ?? 0) + Math.min(side, 1500) / 750 - (side < 400 ? 3 : 0);
  };
  // Pictures placed by hand keep their places; any found since follow, best first.
  const ordered = [...results].sort((a, b) => {
    const pa = placed.indexOf(a.key);
    const pb = placed.indexOf(b.key);
    if (pa >= 0 || pb >= 0) return (pa < 0 ? Infinity : pa) - (pb < 0 ? Infinity : pb);
    return score(b) - score(a);
  });
  if (ordered.length) {
    await env.DB.batch(ordered.map((r, i) => env.DB.prepare(`UPDATE artist_image SET position = ? WHERE artist_id = ? AND key = ?`).bind(i, artistId, r.key)));
  }
}

/** The pictures in the order dragged into, kept through later fetches. */
export async function setImageOrder(userId: string, artistId: string, keys: string[]): Promise<void> {
  const held = new Set(
    (await env.DB.prepare(`SELECT key FROM artist_image WHERE artist_id = ?`).bind(artistId).all<{ key: string }>()).results.map((r) => r.key),
  );
  const order = keys.filter((k) => held.has(k));
  await env.DB.prepare(
    `INSERT INTO field_override (entity_type, entity_id, field, value_json, user_id) VALUES ('artist', ?, 'image_order', ?, ?)
     ON CONFLICT (entity_type, entity_id, field) DO UPDATE SET value_json = excluded.value_json, user_id = excluded.user_id`,
  )
    .bind(artistId, JSON.stringify(order), userId)
    .run();
  await rankArtistImages(artistId);
}

/** Puts one picture first for good: later fetches rank around it. */
export async function setFirstImage(userId: string, artistId: string, key: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO field_override (entity_type, entity_id, field, value_json, user_id) VALUES ('artist', ?, 'first_image', ?, ?)
     ON CONFLICT (entity_type, entity_id, field) DO UPDATE SET value_json = excluded.value_json, user_id = excluded.user_id`,
  )
    .bind(artistId, JSON.stringify(key), userId)
    .run();
  await rankArtistImages(artistId);
}

/** Finds and stores pictures for one artist. Returns how many are new. */
export async function fetchArtistImages(artistId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT name, mbid, wikidata_id, spotify_id FROM artist WHERE id = ?`)
    .bind(artistId)
    .first<{ name: string; mbid: string | null; wikidata_id: string | null; spotify_id: string | null }>();
  if (!row) return 0;

  const candidates: Candidate[] = [];
  if (row.mbid) candidates.push(...(await fanartCandidates(row.mbid).catch(() => [])));
  if (row.spotify_id) {
    const spotify = await spotifyCandidate(row.spotify_id).catch(() => null);
    if (spotify) candidates.push(spotify);
  }
  // Deezer and Genius next: large, recent portraits.
  for (const find of [deezerCandidate, geniusCandidate]) {
    const found = await find(row.name).catch(() => null);
    if (found) candidates.push(found);
  }
  if (row.wikidata_id) candidates.push(...(await wikimediaCandidates(row.wikidata_id).catch(() => [])));

  const existing = await env.DB.prepare(`SELECT count(*) AS n FROM artist_image WHERE artist_id = ?`).bind(artistId).first<number>('n');
  let added = 0;
  let position = existing ?? 0;
  for (const c of candidates.slice(0, MAX_IMAGES)) {
    const key = await keyFor(artistId, c.url);
    const held = await env.DB.prepare(`SELECT 1 AS ok FROM artist_image WHERE artist_id = ? AND key = ?`).bind(artistId, key).first();
    if (held) continue;
    const response = await fetch(c.url, { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) continue;
    const bytes = await response.arrayBuffer();
    // A black square or a stock silhouette standing in for a photo is worse than none.
    if (looksBlank(new Uint8Array(bytes))) continue;
    await env.ASSET_STORE.put(key, bytes, {
      httpMetadata: { contentType: response.headers.get('content-type') ?? 'image/jpeg' },
    });
    await env.DB.prepare(
      `INSERT INTO artist_image (id, artist_id, key, source, source_url, credit, licence, width, height, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
      .bind(crypto.randomUUID(), artistId, key, c.source, c.source_url, c.credit, c.licence, c.width, c.height, position++)
      .run();
    added++;
  }
  await rankArtistImages(artistId);
  return added;
}

export interface ArtistImage {
  key: string;
  source: 'wikimedia' | 'spotify' | 'deezer' | 'genius' | 'fanart' | 'manual';
  source_url: string | null;
  credit: string | null;
  licence: string | null;
  width: number | null;
  height: number | null;
}

export async function artistImages(artistId: string): Promise<ArtistImage[]> {
  const { results } = await env.DB.prepare(
    `SELECT key, source, source_url, credit, licence, width, height FROM artist_image
     WHERE artist_id = ? AND hidden = 0 ORDER BY position, key`,
  )
    .bind(artistId)
    .all<ArtistImage>();
  return results;
}
