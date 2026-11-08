/**
 * Importing an artist's whole discography: their release groups on
 * MusicBrainz, filtered to the kinds asked for, minus anything already in
 * the library, each queued as an ordinary import. Found from a MusicBrainz
 * or Spotify artist link, or by name.
 */

import { env } from 'cloudflare:workers';
import { enqueueMany } from '../jobs/queue';
import { removedMbids } from '../official';
import { artistForSpotify, browseArtistReleaseGroups, searchArtists, type MbReleaseGroupSummary } from '../musicbrainz/client';
import { normaliseName } from '../text';
import { ownerId } from '../auth/user';
import type { Getter } from '../spotify/album';
import { MARKET, spotifyFor } from '../spotify/client';

export const KINDS = {
  album: 'Albums and mixtapes',
  ep: 'EPs',
  single: 'Singles',
  live: 'Live albums',
  compilation: 'Compilations',
} as const;
export type Kind = keyof typeof KINDS;

export class DiscographyError extends Error {}

/**
 * The artist an input names: on MusicBrainz where it knows them, or, for a
 * Spotify link MusicBrainz has nothing for, the Spotify artist itself.
 */
export async function resolveArtist(input: string): Promise<{ id: string; name: string; source: 'musicbrainz' | 'spotify' }> {
  const value = input.trim();
  const mb = /musicbrainz\.org\/artist\/([0-9a-f-]{36})/i.exec(value)?.[1];
  if (mb) return { id: mb.toLowerCase(), name: '', source: 'musicbrainz' };
  const spotify = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?artist\/([A-Za-z0-9]{22})|spotify:artist:([A-Za-z0-9]{22})/.exec(value);
  if (spotify) {
    const spotifyId = spotify[1] ?? spotify[2]!;
    const found = await artistForSpotify(spotifyId);
    return found ? { ...found, source: 'musicbrainz' } : { id: spotifyId, name: '', source: 'spotify' };
  }
  if (!value) throw new DiscographyError('Give an artist’s name or a link to them.');
  const hits = await searchArtists(value);
  const exact = hits.filter((h) => normaliseName(h.name) === normaliseName(value)).sort((a, b) => b.score - a.score);
  const best = exact[0] ?? hits[0];
  if (!best || best.score < 90) throw new DiscographyError(`No artist called “${value}” on MusicBrainz. Their Spotify page works for anyone MusicBrainz lacks.`);
  return { id: best.id, name: best.name, source: 'musicbrainz' };
}

interface SpotifyAlbumSummary {
  id: string;
  name: string;
  album_type: 'album' | 'single' | 'compilation';
  total_tracks: number;
  release_date: string;
}

/** Spotify's kinds in ours: a "single" of four or more tracks is an EP. */
export function spotifyKind(a: Pick<SpotifyAlbumSummary, 'album_type' | 'total_tracks' | 'name'>): Kind {
  if (a.album_type === 'compilation') return 'compilation';
  if (a.album_type === 'single') return a.total_tracks >= 4 ? 'ep' : 'single';
  return /\b(live|en vivo|ao vivo)\b/i.test(a.name) ? 'live' : 'album';
}

/**
 * For an artist MusicBrainz does not have: their releases as Spotify lists
 * them (their own, not appearances on others'), each queued as an ordinary
 * Spotify import, minus any already here, oldest first. A deluxe edition
 * Spotify lists apart lands as an edition of its album, as with one link.
 */
export async function queueSpotifyDiscography(
  artistId: string,
  kinds: Set<Kind>,
  client?: Getter,
): Promise<{ queued: { id: string; title: string }[]; skipped: number; found: number; name: string }> {
  let spotify = client;
  if (!spotify) {
    const owner = await ownerId();
    if (!owner) throw new DiscographyError('No owner account yet.');
    spotify = spotifyFor(owner);
  }
  const artist = await spotify.get<{ name: string }>(`/artists/${artistId}`);
  const albums: SpotifyAlbumSummary[] = [];
  // Small pages, followed to the end: Development Mode caps some page sizes.
  let path: string | null = `/artists/${artistId}/albums?include_groups=album,single,compilation&market=${MARKET}&limit=10`;
  for (let page = 0; path && page < 40; page++) {
    const result: { items: SpotifyAlbumSummary[]; next: string | null } = await spotify.get(path);
    albums.push(...result.items);
    path = result.next ? result.next.replace(/^https:\/\/api\.spotify\.com\/v1/, '') : null;
  }
  const today = new Date().toISOString().slice(0, 10);
  const wantedAlbums = [...new Map(albums.map((a) => [a.id, a])).values()].filter((a) => kinds.has(spotifyKind(a)) && a.release_date <= today);
  const ids = JSON.stringify(wantedAlbums.map((a) => a.id));
  const held = new Set(
    (
      await env.DB.prepare(
        `SELECT spotify_id FROM release_group WHERE spotify_id IN (SELECT value FROM json_each(?1))
         UNION SELECT spotify_id FROM release WHERE spotify_id IN (SELECT value FROM json_each(?1))`,
      )
        .bind(ids)
        .all<{ spotify_id: string }>()
    ).results.map((r) => r.spotify_id),
  );
  const fresh = wantedAlbums.filter((a) => !held.has(a.id)).sort((a, b) => a.release_date.localeCompare(b.release_date));
  const jobIds = await enqueueMany(
    'import_release',
    fresh.map((a) => ({ source: 'spotify' as const, target: { kind: 'album' as const, id: a.id }, label: a.name })),
  );
  return { queued: fresh.map((a, i) => ({ id: jobIds[i]!, title: a.name })), skipped: wantedAlbums.length - fresh.length, found: wantedAlbums.length, name: artist.name };
}

/** Whether a release group is one of the kinds asked for. */
export function wanted(group: MbReleaseGroupSummary, kinds: Set<Kind>): boolean {
  const primary = group['primary-type'];
  const secondary = new Set(group['secondary-types'] ?? []);
  // Never: interviews, spoken word, audiobooks, demos, DJ mixes, field recordings.
  if (['Interview', 'Spokenword', 'Audiobook', 'Audio drama', 'Demo', 'DJ-mix', 'Field recording'].some((t) => secondary.has(t))) return false;
  if (secondary.has('Live')) return kinds.has('live');
  if (secondary.has('Compilation')) return kinds.has('compilation');
  if (secondary.has('Remix')) return kinds.has('compilation');
  if (primary === 'Album') return kinds.has('album');
  if (primary === 'EP') return kinds.has('ep');
  if (primary === 'Single') return kinds.has('single');
  return false;
}

/** Queues an import for each wanted release group not already here, oldest first. */
export async function queueDiscography(
  artistMbid: string,
  kinds: Set<Kind>,
): Promise<{ queued: { id: string; title: string }[]; skipped: number; found: number }> {
  const today = new Date().toISOString().slice(0, 10);
  const groups = (await browseArtistReleaseGroups(artistMbid)).filter(
    (g) => wanted(g, kinds) && g['first-release-date'] && g['first-release-date'] <= today,
  );
  const held = new Set(
    (
      await env.DB.prepare(`SELECT mbid FROM release_group WHERE mbid IN (SELECT value FROM json_each(?))`)
        .bind(JSON.stringify(groups.map((g) => g.id)))
        .all<{ mbid: string }>()
    ).results.map((r) => r.mbid),
  );
  // Albums Cillian removed stay removed.
  const removed = await removedMbids(groups.map((g) => g.id));
  const fresh = groups
    .filter((g) => !held.has(g.id) && !removed.has(g.id))
    .sort((a, b) => (a['first-release-date'] ?? '').localeCompare(b['first-release-date'] ?? ''));
  const ids = await enqueueMany(
    'import_release',
    fresh.map((g) => ({ source: 'musicbrainz' as const, target: { entity: 'release-group' as const, mbid: g.id }, label: g.title })),
  );
  const queued = fresh.map((g, i) => ({ id: ids[i]!, title: g.title }));
  return { queued, skipped: groups.length - queued.length, found: groups.length };
}
