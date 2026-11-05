import { describe, expect, it } from 'vitest';
import { looksBlank, pixelSize } from './image-size';

/** A JPEG-shaped file: SOI, an APP0 segment, a frame header with the size, padded to `bytes`. */
function jpeg(width: number, height: number, bytes = 2000): Uint8Array {
  const head = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0), 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03];
  const out = new Uint8Array(Math.max(bytes, head.length + 16));
  out.set(head);
  return out;
}

function png(width: number, height: number, bytes = 2000): Uint8Array {
  const out = new Uint8Array(bytes);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(out.buffer).setUint32(16, width);
  new DataView(out.buffer).setUint32(20, height);
  return out;
}

function webpExtended(width: number, height: number): Uint8Array {
  const out = new Uint8Array(64);
  out.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  out.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8);
  const w = width - 1, h = height - 1;
  out.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 24);
  return out;
}

describe('pixelSize', () => {
  it('reads JPEG, PNG and WebP headers', () => {
    expect(pixelSize(jpeg(640, 480))).toEqual({ width: 640, height: 480 });
    expect(pixelSize(png(1000, 750))).toEqual({ width: 1000, height: 750 });
    expect(pixelSize(webpExtended(1200, 900))).toEqual({ width: 1200, height: 900 });
  });

  it('gives up on anything else', () => {
    expect(pixelSize(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(pixelSize(new Uint8Array([0xff, 0xd8, 0x00]))).toBeNull();
  });
});

describe('looksBlank', () => {
  it('flags a large image that compressed to almost nothing', () => {
    // Ye's all-black Spotify picture: 640 × 640 in 5,084 bytes.
    expect(looksBlank(jpeg(640, 640, 5_084))).toBe(true);
  });

  it('keeps logos and dark photos, which carry real detail', () => {
    expect(looksBlank(jpeg(640, 640, 13_941))).toBe(false); // a helmet logo, 0.034 bytes a pixel
    expect(looksBlank(jpeg(1000, 1000, 38_143))).toBe(false); // a dark stage portrait
    expect(looksBlank(jpeg(640, 640, 120_000))).toBe(false); // an ordinary photo
  });

  it('never judges small images or ones it cannot measure', () => {
    expect(looksBlank(jpeg(150, 150, 300))).toBe(false);
    expect(looksBlank(new Uint8Array(100))).toBe(false);
  });
});
