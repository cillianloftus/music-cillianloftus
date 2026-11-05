/**
 * Importing an artist's whole discography: their release groups on
 * MusicBrainz, filtered to the kinds asked for, minus anything already in
 * the library, each queued as an ordinary import. Found from a MusicBrainz
 * or Spotify artist link, or by name.
 */

import { env } from 'cloudflare:workers';
import { enqueueMany } from '../jobs/queue';
import { artistForSpotify, browseArtistReleaseGroups, searchArtists, type MbReleaseGroupSummary } from '../musicbrainz/client';
import { normaliseName } from '../text';

export const KINDS = {
  album: 'Albums and mixtapes',
  ep: 'EPs',
  single: 'Singles',
  live: 'Live albums',
  compilation: 'Compilations',
} as const;
export type Kind = keyof typeof KINDS;

export class DiscographyError extends Error {}

/** The MusicBrainz artist an input names. */
export async function resolveArtist(input: string): Promise<{ id: string; name: string }> {
  const value = input.trim();
  const mb = /musicbrainz\.org\/artist\/([0-9a-f-]{36})/i.exec(value)?.[1];
  if (mb) return { id: mb.toLowerCase(), name: '' };
  const spotify = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?artist\/([A-Za-z0-9]{22})|spotify:artist:([A-Za-z0-9]{22})/.exec(value);
  if (spotify) {
    const found = await artistForSpotify(spotify[1] ?? spotify[2]!);
    if (!found) throw new DiscographyError('MusicBrainz has no artist linked to that Spotify page. Try their name, or their MusicBrainz page.');
    return found;
  }
  if (!value) throw new DiscographyError('Give an artist’s name or a link to them.');
  const hits = await searchArtists(value);
  const exact = hits.filter((h) => normaliseName(h.name) === normaliseName(value)).sort((a, b) => b.score - a.score);
  const best = exact[0] ?? hits[0];
  if (!best || best.score < 90) throw new DiscographyError(`No artist called “${value}” on MusicBrainz.`);
  return { id: best.id, name: best.name };
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
  const fresh = groups
    .filter((g) => !held.has(g.id))
    .sort((a, b) => (a['first-release-date'] ?? '').localeCompare(b['first-release-date'] ?? ''));
  const ids = await enqueueMany(
    'import_release',
    fresh.map((g) => ({ source: 'musicbrainz' as const, target: { entity: 'release-group' as const, mbid: g.id } })),
  );
  const queued = fresh.map((g, i) => ({ id: ids[i]!, title: g.title }));
  return { queued, skipped: groups.length - queued.length, found: groups.length };
}
