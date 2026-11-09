/**
 * Artist pictures at the sizes pages show them: each stored picture
 * (art/artist/<id>/<name>.jpg) can be asked for as a WebP at these widths
 * (src/pages/art/artist/[id]/[file].ts), made once and kept. The original
 * stays, for the largest uses.
 */

export const PICTURE_WIDTHS = [160, 320, 640, 960] as const;

/** A srcset of the picture's WebP widths, for an <img> that also names `sizes`. */
export function pictureSrcset(key: string): string {
  const base = key.replace(/\.jpg$/, '');
  return PICTURE_WIDTHS.map((w) => `/${base}-${w}.webp ${w}w`).join(', ');
}

/** The picture at one width, for a background or a single small use. */
export function pictureAt(key: string, width: (typeof PICTURE_WIDTHS)[number]): string {
  return `/${key.replace(/\.jpg$/, '')}-${width}.webp`;
}
