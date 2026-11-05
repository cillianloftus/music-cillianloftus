/**
 * Album covers from Apple's iTunes Search API: free, no key, and served at
 * any size up to the original (often 3000 px), so the large derivative is
 * sharper than Spotify's 640 px. Used only where an edition has no cover of
 * its own on the Cover Art Archive.
 */

import { normaliseName, normaliseTitle } from '../text';

interface ItunesAlbum {
  collectionName: string;
  artistName: string;
  artworkUrl100?: string;
}

/**
 * The cover's URL template ("…/{size}x{size}bb.jpg") for the album by this
 * artist with this title, or null. Edition words ("(Deluxe)") are ignored
 * in matching, as everywhere.
 */
export async function itunesCover(artist: string, title: string, fetcher: typeof fetch = fetch): Promise<((size: number) => string) | null> {
  const res = await fetcher(`https://itunes.apple.com/search?${new URLSearchParams({ term: `${artist} ${title}`, entity: 'album', limit: '10' })}`);
  if (!res.ok) return null;
  const { results } = (await res.json()) as { results: ItunesAlbum[] };
  const wantTitle = normaliseTitle(title);
  const wantArtist = normaliseName(artist);
  const hit = results.find((r) => normaliseTitle(r.collectionName) === wantTitle && normaliseName(r.artistName) === wantArtist && r.artworkUrl100);
  if (!hit) return null;
  const template = hit.artworkUrl100!;
  return (size: number) => template.replace(/\/\d+x\d+bb\.(jpg|png)$/, `/${size}x${size}bb.jpg`);
}
