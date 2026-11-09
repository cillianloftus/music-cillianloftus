/**
 * Cover art from the Cover Art Archive, stored in R2 as fixed-width
 * derivatives so pages can offer a srcset instead of sending phones the
 * full-resolution scan.
 * https://musicbrainz.org/doc/Cover_Art_Archive/API
 */

import { env } from 'cloudflare:workers';
import { servePicture, waitUntilOf } from '../art-serve';

export const ART_SIZES = [250, 500, 1200] as const;
export type ArtSize = (typeof ART_SIZES)[number];

/**
 * Where a cover stored now goes: a new version each time, never over the
 * last, so every cover address shows one image for good and can be kept a
 * year by browsers and the edge (src/lib/art-serve.ts). Covers stored
 * before this sit at art/release/<id> and are never written again.
 */
export function artKeyFor(releaseId: string, now = Date.now()): string {
  return `art/release/${releaseId}/${now.toString(36)}`;
}

/**
 * WebP widths pages ask for (CoverArt's srcset): a third to half the bytes
 * of the JPEGs, with a small one for list thumbnails and one between 500
 * and 1200 for a phone's full-width cover. Each is made from the stored
 * JPEGs the first time it is asked for, and kept beside them; the JPEGs,
 * the 1200 among them, are never touched.
 */
export const WEBP_SIZES = [128, 250, 500, 800, 1200] as const;

const ID = /^[0-9a-f-]{1,64}$/i;
const VERSION = /^[0-9a-z]{6,12}$/;

/**
 * Serves one size of a cover. A JPEG size never stored (small originals
 * have no 1200) falls back to the largest smaller one.
 */
export function serveCover(request: Request, locals: unknown, id: string | undefined, version: string | null, file: string | undefined): Promise<Response> | Response {
  const [, width, format] = /^(\d+)\.(jpg|webp)$/.exec(file ?? '') ?? [];
  const size = Number(width);
  const known = format === 'webp' ? WEBP_SIZES.includes(size as (typeof WEBP_SIZES)[number]) : ART_SIZES.includes(size as ArtSize);
  if (!id || !ID.test(id) || (version !== null && !VERSION.test(version)) || !known) {
    return new Response('Not found', { status: 404 });
  }
  const base = version ? `art/release/${id}/${version}` : `art/release/${id}`;
  if (format === 'webp') return servePicture(request, [`${base}/${size}.webp`], waitUntilOf(locals), () => makeWebp(base, size));
  const keys = ART_SIZES.filter((s) => s <= size)
    .reverse()
    .map((s) => `${base}/${s}.jpg`);
  return servePicture(request, keys, waitUntilOf(locals));
}

/**
 * A WebP of the cover at `size` wide, from the smallest stored JPEG at
 * least that wide (else the largest there is, never enlarged), stored for
 * next time. Null when there is no cover or resizing fails: the caller
 * then sends the JPEG, briefly cached, so a later request tries again.
 */
async function makeWebp(base: string, size: number): Promise<Response | null> {
  const sources = [...ART_SIZES.filter((s) => s >= size), ...ART_SIZES.filter((s) => s < size).reverse()];
  for (const source of sources) {
    const jpeg = await env.ASSET_STORE.get(`${base}/${source}.jpg`);
    if (!jpeg) continue;
    try {
      const made = await env.IMAGES.input(jpeg.body)
        .transform({ width: size, fit: 'scale-down' })
        .output({ format: 'image/webp', quality: 80 });
      const bytes = await new Response(made.image()).arrayBuffer();
      await env.ASSET_STORE.put(`${base}/${size}.webp`, bytes, { httpMetadata: { contentType: 'image/webp' } });
      return new Response(bytes, { headers: { 'Content-Type': 'image/webp' } });
    } catch (error) {
      console.warn('Cover resize failed', base, size, error);
      const fallback = await env.ASSET_STORE.get(`${base}/${source}.jpg`);
      if (!fallback) return null;
      return new Response(fallback.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' } });
    }
  }
  return null;
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
