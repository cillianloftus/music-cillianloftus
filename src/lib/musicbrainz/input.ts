export type MbEntity = 'release' | 'release-group';

export interface MbTarget {
  entity: MbEntity;
  mbid: string;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Accepts a MusicBrainz release or release-group URL, or a bare MBID (taken
 * as a release group, since that is what "this album" usually means).
 */
export function parseMbInput(input: string): MbTarget | null {
  const value = input.trim();
  const id = value.match(UUID)?.[0]?.toLowerCase();
  if (!id) return null;

  if (/^[0-9a-f-]{36}$/i.test(value)) return { entity: 'release-group', mbid: id };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!/(^|\.)musicbrainz\.org$/.test(url.hostname)) return null;

  const [, kind] = url.pathname.split('/');
  if (kind === 'release') return { entity: 'release', mbid: id };
  if (kind === 'release-group') return { entity: 'release-group', mbid: id };
  return null;
}
