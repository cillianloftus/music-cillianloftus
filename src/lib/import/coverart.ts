/**
 * Cover art from the Cover Art Archive, stored in R2 as fixed-width
 * derivatives so pages can offer a srcset instead of sending phones the
 * full-resolution scan.
 * https://musicbrainz.org/doc/Cover_Art_Archive/API
 */

import { env } from 'cloudflare:workers';

export const ART_SIZES = [250, 500, 1200] as const;
export type ArtSize = (typeof ART_SIZES)[number];

export function artKeyFor(releaseId: string): string {
  return `art/release/${releaseId}`;
}

async function fetchFront(path: string, size: ArtSize): Promise<ArrayBuffer | null> {
  const response = await fetch(`https://coverartarchive.org/${path}/front-${size}`, {
    redirect: 'follow',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Cover Art Archive returned ${response.status} for ${path}`);
  return response.arrayBuffer();
}

/**
 * Stores front art for a release, falling back to the release group's
 * chosen front when this edition has none. Returns the stored key prefix,
 * or null when no art exists for either.
 */
export async function storeCoverArt(opts: {
  releaseId: string;
  releaseMbid: string;
  releaseGroupMbid: string;
}): Promise<string | null> {
  const candidates = [`release/${opts.releaseMbid}`, `release-group/${opts.releaseGroupMbid}`];

  for (const path of candidates) {
    const smallest = await fetchFront(path, ART_SIZES[0]);
    if (!smallest) continue;

    const key = artKeyFor(opts.releaseId);
    const images: [ArtSize, ArrayBuffer][] = [[ART_SIZES[0], smallest]];
    for (const size of ART_SIZES.slice(1)) {
      const image = await fetchFront(path, size);
      if (image) images.push([size, image]);
    }

    await Promise.all(
      images.map(([size, body]) =>
        env.ASSET_STORE.put(`${key}/${size}.jpg`, body, {
          httpMetadata: { contentType: 'image/jpeg' },
        }),
      ),
    );
    await env.DB.prepare('UPDATE release SET art_key = ? WHERE id = ?').bind(key, opts.releaseId).run();
    return key;
  }

  return null;
}
