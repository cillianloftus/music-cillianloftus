/**
 * Versions of a song: a remix, a sped-up or slowed take, an acoustic or
 * live cut, an instrumental. A different recording of the same song, so
 * not a duplicate to merge (normaliseTitle keeps these words for that
 * reason), but one to link: recordings sharing a work show as versions of
 * one track and collapse into one song in playlists.
 *
 * A title is split into the song and its version words: "Song (Kaytranada
 * Remix) [feat. X]" is the song "song", version "Kaytranada Remix".
 */

import { normaliseTitle } from './text';

/** Words that make a bracket or a " - " tail name a version. */
const VERSION_WORDS =
  /\b(re-?mix(es|ed)?|mix|edit|re-?work(ed)?|flip|vip|bootleg|sped[ -]?up|speed ?up|slowed|reverb|nightcore|acoustic|live|demo|instrumental|a ?cappella|acapella|version|stripped|extended|piano|orchestral|mash-?up|remake|re-?recorded|unplugged|rendition|dub|session|cover|visualiz?ser|8d|chopped|screwed)\b/i;

/** "feat. X", "ft. X", "with X" in brackets, and a trailing "feat. X". */
const FEATURING = /\s*[([](?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]|\s+(?:feat\.?|ft\.?|featuring)\s.+$/giu;

export interface TitleParts {
  /** The song, normalised for matching. */
  song: string;
  /** The version words, as written; null for the song itself. */
  version: string | null;
}

export function splitVersion(title: string): TitleParts {
  let rest = title.replace(FEATURING, '');
  const versions: string[] = [];
  rest = rest.replace(/\s*[([]([^)\]]+)[)\]]/gu, (match, inner: string) => {
    if (!VERSION_WORDS.test(inner)) return match;
    versions.push(inner.trim());
    return '';
  });
  rest = rest.replace(/\s+[-–—]\s+([^-–—]+)$/u, (match, tail: string) => {
    if (!VERSION_WORDS.test(tail)) return match;
    versions.push(tail.trim());
    return '';
  });
  return { song: normaliseTitle(rest), version: versions.length ? versions.join(', ') : null };
}

export interface VersionCandidate {
  id: string;
  title: string;
  artist_id: string;
  work_id: string | null;
  /** On an official non-live release. */
  studio: number;
}

/**
 * Each version paired with the song as first released, by the same
 * artist: [original, version]. Nothing is paired where there is no plain
 * original to anchor it, where both already share a work, or where they
 * belong to different works (a work merge, which is not this).
 */
export function versionPairs(rows: VersionCandidate[], generic: RegExp): [string, string][] {
  const byKey = new Map<string, { row: VersionCandidate; version: string | null }[]>();
  for (const row of rows) {
    const parts = splitVersion(row.title);
    if (!parts.song || generic.test(parts.song)) continue;
    const key = `${row.artist_id}\u0000${parts.song}`;
    const list = byKey.get(key) ?? [];
    list.push({ row, version: parts.version });
    byKey.set(key, list);
  }

  const out: [string, string][] = [];
  const seen = new Set<string>();
  for (const members of byKey.values()) {
    const originals = members.filter((m) => m.version === null).map((m) => m.row);
    const versions = members.filter((m) => m.version !== null).map((m) => m.row);
    if (originals.length === 0 || versions.length === 0) continue;
    // One anchor: already part of a work, then on a studio release, then the earliest id.
    const anchor = [...originals].sort(
      (a, b) => Number(b.work_id !== null) - Number(a.work_id !== null) || b.studio - a.studio || a.id.localeCompare(b.id),
    )[0]!;
    for (const v of versions) {
      if (v.id === anchor.id) continue;
      if (v.work_id !== null && anchor.work_id !== null) continue;
      const key = `${anchor.id}\u0000${v.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([anchor.id, v.id]);
    }
  }
  return out;
}
