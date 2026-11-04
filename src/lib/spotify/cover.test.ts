import { describe, expect, it } from 'vitest';
import { sameAlbum } from './match';
import { isSmallJpeg } from './push';

const jpeg = (size: number) => {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
};

describe('isSmallJpeg', () => {
  it('accepts a JPEG within Spotify’s cover limit', () => {
    expect(isSmallJpeg(jpeg(16_682))).toBe(true);
    expect(isSmallJpeg(jpeg(190_000))).toBe(true);
  });

  it('refuses anything too big for 256 KB of base64, or not a JPEG', () => {
    expect(isSmallJpeg(jpeg(190_001))).toBe(false);
    const png = new Uint8Array(5000);
    png.set([0x89, 0x50, 0x4e, 0x47]);
    expect(isSmallJpeg(png)).toBe(false);
    expect(isSmallJpeg(new Uint8Array(0))).toBe(false);
  });
});

describe('sameAlbum', () => {
  const track = (name: string, album_type = 'album') => ({ id: 't', name: 'Dreams', artists: [], album: { id: 'a', name, album_type } });

  it('matches the recording’s album, edition words aside', () => {
    expect(sameAlbum({ album_title: 'Rumours' }, track('Rumours (Super Deluxe)'))).toBe(true);
  });

  it('never takes a compilation or another album', () => {
    expect(sameAlbum({ album_title: 'Rumours' }, track('Rumours', 'compilation'))).toBe(false);
    expect(sameAlbum({ album_title: 'Rumours' }, track('50 Years – Don’t Stop'))).toBe(false);
    expect(sameAlbum({ album_title: null }, track('Rumours'))).toBe(false);
  });
});
