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
 * Which release the release group's chosen front belongs to: the archive
 * answers with a redirect to that release's image.
 */
async function groupFrontOwner(releaseGroupMbid: string): Promise<string | null> {
  const response = await fetch(`https://coverartarchive.org/release-group/${releaseGroupMbid}/front-250`, { redirect: 'manual' });
  const location = response.headers.get('location') ?? '';
  return /\/release\/([0-9a-f-]{36})\//.exec(location)?.[1] ?? null;
}

/**
 * Stores front art for a release, falling back to the release group's
 * chosen front when this edition has none, unless that front is another
 * edition's we hold (The Instrumentals' cover is not the album's). Returns
 * the stored key prefix, or null when there is nothing suitable.
 */
export async function storeCoverArt(opts: {
  releaseId: string;
  releaseMbid: string;
  releaseGroupMbid: string;
  /** False: this release's own art or nothing. */
  groupFallback?: boolean;
}): Promise<string | null> {
  const candidates = [`release/${opts.releaseMbid}`];
  if (opts.groupFallback !== false) {
    const owner = await groupFrontOwner(opts.releaseGroupMbid).catch(() => null);
    const another = owner && owner !== opts.releaseMbid
      ? await env.DB.prepare(`SELECT 1 AS yes FROM release WHERE mbid = ? AND id <> ?`).bind(owner, opts.releaseId).first()
      : null;
    if (!another) candidates.push(`release-group/${opts.releaseGroupMbid}`);
  }

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
