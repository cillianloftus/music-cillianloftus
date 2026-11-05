/**
 * Reading an image's pixel size from its header, and telling a blank image
 * (a black square standing in for a profile photo) from a real one,
 * without decoding it: Workers have no image library, and the file size
 * says enough.
 */

export interface PixelSize {
  width: number;
  height: number;
}

/** Width and height from a JPEG, PNG or WebP header; null for anything else. */
export function pixelSize(bytes: Uint8Array): PixelSize | null {
  const at16 = (i: number) => (bytes[i]! << 8) | bytes[i + 1]!;
  const le16 = (i: number) => bytes[i]! | (bytes[i + 1]! << 8);
  const at32 = (i: number) => ((bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) | bytes[i + 3]!) >>> 0;
  const ascii = (i: number, n: number) => String.fromCharCode(...bytes.subarray(i, i + n));

  // PNG: the IHDR chunk comes first.
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(1, 3) === 'PNG') {
    return { width: at32(16), height: at32(20) };
  }

  // JPEG: walk the markers to the frame header (SOF0–SOF15, except DHT, JPG and DAC).
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1]!;
      if (marker === 0xff) {
        i++; // fill byte
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: at16(i + 7), height: at16(i + 5) };
      }
      i += 2 + at16(i + 2);
    }
    return null;
  }

  // WebP: lossy (VP8), lossless (VP8L) or extended (VP8X).
  if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const kind = ascii(12, 4);
    if (kind === 'VP8 ') return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (kind === 'VP8L') {
      const b = (n: number) => bytes[21 + n]!;
      return { width: 1 + (((b(1) & 0x3f) << 8) | b(0)), height: 1 + (((b(3) & 0x0f) << 10) | (b(2) << 2) | ((b(1) & 0xc0) >> 6)) };
    }
    if (kind === 'VP8X') {
      const le24 = (i: number) => bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16);
      return { width: 1 + le24(24), height: 1 + le24(27) };
    }
  }
  return null;
}

/**
 * Below this many bytes per pixel an image is nearly one flat colour:
 * compression has almost nothing to keep. Measured on 1,328 artist
 * pictures (5 Nov 2026): under it were blank black squares (0.012), a
 * stock silhouette placeholder (0.030) and song-title cards; just over it,
 * Marshmello's helmet logo (0.034) and a dark stage portrait (0.038). Real
 * photos mostly sit above 0.1.
 */
export const FLAT_BYTES_PER_PIXEL = 0.032;

/** True for an image that is all but blank. Small images are never judged: headers dominate them. */
export function looksBlank(bytes: Uint8Array): boolean {
  const size = pixelSize(bytes);
  if (!size || size.width < 200 || size.height < 200) return false;
  return bytes.length / (size.width * size.height) < FLAT_BYTES_PER_PIXEL;
}
