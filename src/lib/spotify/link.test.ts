import { describe, expect, it } from 'vitest';
import { pickAlbum } from './link';

const hit = (name: string, overrides: Record<string, unknown> = {}) => ({
  id: name,
  name,
  album_type: 'album',
  release_date: '2025-03-21',
  total_tracks: 14,
  artists: [{ name: 'Quadeca' }],
  ...overrides,
});
const album = { title: 'Vanisher, Horizon Scraper', artist: 'Quadeca', first_release_date: '2025-03-21', track_count: 14 };

describe('pickAlbum', () => {
  it('takes the album with the same title and artist', () => {
    expect(pickAlbum(album, [hit('Something Else'), hit('Vanisher, Horizon Scraper')])?.id).toBe('Vanisher, Horizon Scraper');
  });

  it('prefers the standard edition over a deluxe one, by length', () => {
    const deluxe = hit('Vanisher, Horizon Scraper (Deluxe)', { id: 'deluxe', total_tracks: 18 });
    const standard = hit('Vanisher, Horizon Scraper', { id: 'standard' });
    expect(pickAlbum(album, [deluxe, standard])?.id).toBe('standard');
  });

  it('never takes a compilation, another artist, or a near title', () => {
    expect(pickAlbum(album, [hit('Vanisher, Horizon Scraper', { album_type: 'compilation' })])).toBeNull();
    expect(pickAlbum(album, [hit('Vanisher, Horizon Scraper', { artists: [{ name: 'Someone' }] })])).toBeNull();
    expect(pickAlbum(album, [hit('Vanisher')])).toBeNull();
  });
});
