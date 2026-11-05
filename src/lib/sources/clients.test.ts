/**
 * The outside clients against answers shaped like each service's documented
 * responses, since none can be called from a test.
 */
import { describe, expect, it } from 'vitest';
import { findRelease, formatWords } from './discogs';
import { fanartFor } from './fanart';
import { artistInfo, LastfmError, scrobblesBetween, userInfo } from './lastfm';
import { listensBefore } from './listenbrainz';
import { liveSummary } from './setlistfm';

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('Last.fm', () => {
  it('reads recent tracks, skipping the one playing now', async () => {
    const urls: string[] = [];
    const fetcher = (async (url: URL) => {
      urls.push(String(url));
      return answer({
        recenttracks: {
          track: [
            { name: 'Now', artist: { '#text': 'A' }, album: { '#text': '' }, '@attr': { nowplaying: 'true' } },
            { name: 'Song', mbid: 'abc', artist: { '#text': 'Artist' }, album: { '#text': 'Album' }, date: { uts: '1767225600' } },
          ],
          '@attr': { totalPages: '1' },
        },
      });
    }) as unknown as typeof fetch;
    const page = await scrobblesBetween('key', 'cillian', { after: 100, before: 2000000000 }, fetcher);
    expect(page).toEqual([{ artist: 'Artist', title: 'Song', album: 'Album', mbid: 'abc', at: 1767225600 }]);
    expect(urls[0]).toContain('method=user.getrecenttracks');
    expect(urls[0]).toContain('from=101');
    expect(urls[0]).toContain('to=1999999999');
  });

  it('copes with a page of one track, which Last.fm sends as an object', async () => {
    const fetcher = (async () =>
      answer({ recenttracks: { track: { name: 'Only', artist: { '#text': 'A' }, date: { uts: '5' } } } })) as unknown as typeof fetch;
    expect(await scrobblesBetween('key', 'u', { after: 0, before: 10 }, fetcher)).toHaveLength(1);
  });

  it('turns an error body into an error, even with a 200', async () => {
    const fetcher = (async () => answer({ error: 10, message: 'Invalid API key - You must be granted a valid key by last.fm' })) as unknown as typeof fetch;
    await expect(userInfo('bad', 'u', fetcher)).rejects.toBeInstanceOf(LastfmError);
  });

  it('reads an artist, falling back from MusicBrainz id to name', async () => {
    const asked: string[] = [];
    const fetcher = (async (url: URL) => {
      asked.push(url.searchParams.get('mbid') ? 'mbid' : 'name');
      if (url.searchParams.get('mbid')) return answer({ error: 6, message: 'The artist you supplied could not be found' });
      return answer({
        artist: {
          url: 'https://www.last.fm/music/Quadeca',
          stats: { listeners: '512000', playcount: '23000000', userplaycount: '410' },
          similar: { artist: [{ name: 'Brakence', url: 'https://www.last.fm/music/Brakence' }] },
          tags: { tag: [{ name: 'Art Pop' }] },
        },
      });
    }) as unknown as typeof fetch;
    const info = await artistInfo('key', { name: 'Quadeca', mbid: 'x' }, 'cillian', fetcher);
    expect(asked).toEqual(['mbid', 'name']);
    expect(info).toMatchObject({ listeners: 512000, userPlaycount: 410, tags: ['art pop'], similar: [{ name: 'Brakence' }] });
  });
});

describe('ListenBrainz', () => {
  it('reads listens, preferring the mapped recording id', async () => {
    const fetcher = (async (url: string) => {
      expect(url).toContain('max_ts=2000');
      return answer({
        payload: {
          listens: [
            {
              listened_at: 1500,
              track_metadata: {
                artist_name: 'Artist',
                track_name: 'Song',
                release_name: 'Album',
                additional_info: { recording_mbid: 'submitted' },
                mbid_mapping: { recording_mbid: 'mapped' },
              },
            },
          ],
        },
      });
    }) as unknown as typeof fetch;
    expect(await listensBefore('cillian', 2000, undefined, fetcher)).toEqual([{ artist: 'Artist', title: 'Song', album: 'Album', mbid: 'mapped', at: 1500 }]);
  });
});

describe('setlist.fm', () => {
  const show = (date: string, songs: string[], extra: Record<string, unknown> = {}) => ({
    eventDate: date,
    url: `https://www.setlist.fm/setlist/x/${date}.html`,
    artist: { url: 'https://www.setlist.fm/setlists/quadeca-1.html' },
    venue: { name: 'The Venue', city: { name: 'Dublin', country: { name: 'Ireland' } } },
    sets: { set: [{ song: songs.map((name) => ({ name })) }] },
    ...extra,
  });

  it('counts songs across shows, once per show, and leaves out tapes', async () => {
    const fetcher = (async () =>
      answer({
        total: 3,
        setlist: [
          show('03-02-2026', ['Sisyphus', 'FORGONE', 'Sisyphus']),
          show('01-02-2026', ['Sisyphus', 'Intro tape']),
          { ...show('28-01-2026', []), sets: { set: [{ song: [{ name: 'Intro tape', tape: true }, { name: 'Sisyphus' }] }] } },
        ],
      })) as unknown as typeof fetch;
    const live = await liveSummary('key', 'mbid', { pages: 1 }, fetcher);
    expect(live?.favourites[0]).toEqual({ title: 'Sisyphus', shows: 3, cover: false });
    expect(live?.favourites.find((f) => f.title === 'Intro tape')?.shows).toBe(1);
    expect(live?.shows[0]).toMatchObject({ date: '2026-02-03', city: 'Dublin', songs: 3 });
    expect(live?.url).toBe('https://www.setlist.fm/setlists/quadeca-1.html');
  });

  it('is null for an artist with no shows', async () => {
    const fetcher = (async () => answer({}, 404)) as unknown as typeof fetch;
    expect(await liveSummary('key', 'mbid', {}, fetcher)).toBeNull();
  });
});

describe('Discogs', () => {
  it('accepts a search hit only when artist and title both match', async () => {
    const fetcher = (async () =>
      answer({
        results: [
          { id: 1, title: 'Someone Else - Album A', label: ['Wrong'] },
          { id: 2, title: 'Xavier (2) - Album A', label: ['Right Records'], country: 'UK', format: ['Vinyl', 'LP', 'Album', 'Vinyl'] },
        ],
      })) as unknown as typeof fetch;
    const hit = await findRelease('token', { artist: 'Xavier', title: 'Album A', barcode: null }, fetcher);
    expect(hit?.id).toBe(2);
    expect(formatWords(hit?.format)).toBe('Vinyl, LP, Album');
  });
});

describe('fanart.tv', () => {
  it('puts the best-liked portraits first, over https', async () => {
    const fetcher = (async (url: string) => {
      expect(url).toContain('/music/mbid-1?api_key=key');
      return answer({
        artistthumb: [
          { url: 'http://assets.fanart.tv/a.jpg', likes: '1' },
          { url: 'https://assets.fanart.tv/b.jpg', likes: '9' },
        ],
      });
    }) as unknown as typeof fetch;
    const art = await fanartFor('key', 'mbid-1', fetcher);
    expect(art?.portraits.map((p) => p.url)).toEqual(['https://assets.fanart.tv/b.jpg', 'https://assets.fanart.tv/a.jpg']);
    expect(art?.backgrounds).toEqual([]);
  });

  it('is null for an artist it has nothing for, and says when the key is wrong', async () => {
    expect(await fanartFor('key', 'x', (async () => answer({}, 404)) as unknown as typeof fetch)).toBeNull();
    await expect(fanartFor('bad', 'x', (async () => answer({}, 401)) as unknown as typeof fetch)).rejects.toThrow(/did not accept/);
  });
});
