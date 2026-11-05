/**
 * What outside services say about an artist, for the lower part of the
 * artist page: Last.fm's listeners, tags and similar artists, setlist.fm's
 * recent shows and most-played songs. Each source is cached in KV for a few
 * days on its own, so a key added later shows up without waiting for the
 * other's cache, and a service being down never breaks the page.
 */

import { env } from 'cloudflare:workers';
import { credentials } from './connections';
import { artistInfo, type LastfmArtist } from './sources/lastfm';
import { liveSummary, type LiveSummary } from './sources/setlistfm';
import { normaliseName, normaliseTitle } from './text';

const TTL = 3 * 24 * 60 * 60;

async function cached<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
  try {
    const hit = await env.CACHE.get<{ value: T | null }>(key, 'json');
    if (hit) return hit.value;
  } catch {
    /* Cache unavailable: ask the source. */
  }
  const value = await load();
  // A miss is cached too, for a day, so an unknown artist isn't asked about on every view.
  try {
    await env.CACHE.put(key, JSON.stringify({ value }), { expirationTtl: value ? TTL : 24 * 60 * 60 });
  } catch {
    /* Uncached is only slower. */
  }
  return value;
}

export interface Elsewhere {
  lastfm: (LastfmArtist & { similarHere: { name: string; id: string | null; url: string }[] }) | null;
  live: (LiveSummary & { favouritesHere: { title: string; shows: number; cover: boolean; trackId: string | null }[] }) | null;
}

export async function elsewhere(artistId: string): Promise<Elsewhere | null> {
  const artist = await env.DB.prepare('SELECT name, mbid FROM artist WHERE id = ?').bind(artistId).first<{ name: string; mbid: string | null }>();
  if (!artist) return null;
  const [lastfmKey, setlistKey] = await Promise.all([credentials('lastfm'), credentials('setlistfm')]);

  const [lastfm, live] = await Promise.all([
    lastfmKey
      ? cached(`elsewhere:lastfm:${artistId}`, () => artistInfo(lastfmKey.api_key!, artist, lastfmKey.username)).catch((error) => {
          console.warn('Last.fm artist failed', error);
          return null;
        })
      : null,
    setlistKey && artist.mbid
      ? cached(`elsewhere:setlist:${artistId}`, () => liveSummary(setlistKey.api_key!, artist.mbid!)).catch((error) => {
          console.warn('setlist.fm failed', error);
          return null;
        })
      : null,
  ]);
  if (!lastfm && !live) return { lastfm: null, live: null };

  // Link what is in the library: similar artists by name, live songs to their tracks.
  const [names, tracks] = await Promise.all([
    lastfm?.similar.length ? env.DB.prepare('SELECT id, name FROM artist').all<{ id: string; name: string }>() : null,
    live?.favourites.length
      ? env.DB.prepare(
          `SELECT r.id, r.title FROM recording r JOIN artist_credit c ON c.entity_type = 'recording' AND c.entity_id = r.id
           WHERE c.artist_id = ? AND c.role = 'primary'`,
        )
          .bind(artistId)
          .all<{ id: string; title: string }>()
      : null,
  ]);
  const byName = new Map((names?.results ?? []).map((a) => [normaliseName(a.name), a.id]));
  const byTitle = new Map<string, string>();
  for (const t of tracks?.results ?? []) if (!byTitle.has(normaliseTitle(t.title))) byTitle.set(normaliseTitle(t.title), t.id);

  return {
    lastfm: lastfm
      ? { ...lastfm, similarHere: lastfm.similar.map((s) => ({ ...s, id: byName.get(normaliseName(s.name)) ?? null })) }
      : null,
    live: live ? { ...live, favouritesHere: live.favourites.map((f) => ({ ...f, trackId: byTitle.get(normaliseTitle(f.title)) ?? null })) } : null,
  };
}
