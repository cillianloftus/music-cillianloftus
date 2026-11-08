import { describe, expect, it } from 'vitest';
import { dedupe, SLACK_MS, type DedupePlay, type PlaySource } from './dedupe';
import { artistKey, titleKey } from './keys';

const T0 = Date.parse('2026-10-03T20:00:00Z');
const MIN = 60_000;

let n = 0;
function listen(source: PlaySource, at: number, artist: string, title: string, ms: number | null = null, recording: string | null = null): DedupePlay {
  n += 1;
  return { id: `${source}-${n}`, source, start: at, ms_played: ms, recording_id: recording, artist_key: artistKey(artist), title_key: titleKey(title) };
}
const spotify = (at: number, artist = 'Kendrick Lamar', title = 'Alright', ms = 219_000, recording: string | null = null) => listen('spotify_export', at, artist, title, ms, recording);
const lastfm = (at: number, artist = 'Kendrick Lamar', title = 'Alright', recording: string | null = null) => listen('lastfm', at, artist, title, null, recording);
const listenbrainz = (at: number, artist = 'Kendrick Lamar', title = 'Alright', ms: number | null = null) => listen('listenbrainz', at, artist, title, ms);

const counted = (plays: DedupePlay[]) => dedupe(plays).filter((d) => d.counted === 1).map((d) => d.id).sort();
const copyOf = (plays: DedupePlay[]) => Object.fromEntries(dedupe(plays).filter((d) => d.duplicate_of).map((d) => [d.id, d.duplicate_of]));

describe('one stream in two sources counts once', () => {
  it('Spotify export and a Last.fm scrobble of the same stream', () => {
    const s = spotify(T0);
    const l = lastfm(T0 + 2_000);
    expect(counted([s, l])).toEqual([s.id]);
    expect(copyOf([s, l])).toEqual({ [l.id]: s.id });
  });

  it('whichever order they arrive in, the export is the one that counts', () => {
    const l = lastfm(T0);
    const s = spotify(T0 + 1_000);
    expect(counted([l, s])).toEqual([s.id]);
  });

  it('when the sources name the song differently', () => {
    const s = spotify(T0, 'Kendrick Lamar', 'Alright');
    const l = lastfm(T0, 'Kendrick Lamar feat. Pharrell', 'Alright (feat. Pharrell Williams)');
    const caps = listenbrainz(T0 + 3_000, 'KENDRICK LAMAR', 'alright');
    expect(counted([s, l, caps])).toEqual([s.id]);
  });

  it('when both are matched to one recording under different titles', () => {
    const s = spotify(T0, 'Kendrick Lamar', 'Alright', 219_000, 'rec-1');
    const l = lastfm(T0, 'Kendrick Lamar', 'Alright - Single Version', 'rec-1');
    expect(counted([s, l])).toEqual([s.id]);
  });

  it('when a scrobbler stamps the end of the track instead of the start', () => {
    const s = spotify(T0, undefined, undefined, 219_000);
    const l = lastfm(T0 + 219_000);
    expect(counted([s, l])).toEqual([s.id]);
  });

  it('when the clocks disagree by up to two minutes', () => {
    const s = spotify(T0);
    const l = lastfm(T0 - SLACK_MS + 1_000);
    expect(counted([s, l])).toEqual([s.id]);
  });

  it('across all three sources: one counts, two copies', () => {
    const s = spotify(T0);
    const lb = listenbrainz(T0 + 1_000);
    const l = lastfm(T0 + 1_500);
    expect(counted([l, lb, s])).toEqual([s.id]);
    expect(copyOf([l, lb, s])).toEqual({ [lb.id]: s.id, [l.id]: s.id });
  });

  it('Last.fm against ListenBrainz with no export: ListenBrainz counts', () => {
    const l = lastfm(T0);
    const lb = listenbrainz(T0 + 20_000);
    expect(counted([l, lb])).toEqual([lb.id]);
  });
});

describe('separate listens stay separate', () => {
  it('a song on repeat: five streams and five scrobbles are five plays, each paired to its own', () => {
    const ms = 180_000;
    const streams = Array.from({ length: 5 }, (_, i) => spotify(T0 + i * ms, undefined, undefined, ms));
    const scrobbles = Array.from({ length: 5 }, (_, i) => lastfm(T0 + i * ms + 1_000));
    const all = [...scrobbles, ...streams];
    expect(counted(all)).toEqual(streams.map((s) => s.id).sort());
    const pairs = copyOf(all);
    scrobbles.forEach((s, i) => expect(pairs[s.id]).toBe(streams[i]!.id));
  });

  it('more scrobbles than streams: the extras count', () => {
    const s = spotify(T0, undefined, undefined, 180_000);
    const a = lastfm(T0);
    const b = lastfm(T0 + 180_000);
    expect(counted([s, a, b])).toEqual([s.id, b.id].sort());
  });

  it('one source never deduplicates against itself, however close', () => {
    const a = lastfm(T0);
    const b = lastfm(T0 + 30_000);
    expect(counted([a, b])).toEqual([a.id, b.id].sort());
  });

  it('different songs at the same moment', () => {
    const s = spotify(T0, 'Kendrick Lamar', 'Alright');
    const l = lastfm(T0, 'Kendrick Lamar', 'King Kunta');
    expect(counted([s, l])).toEqual([s.id, l.id].sort());
  });

  it('the same song by another artist', () => {
    const s = spotify(T0, 'Bon Iver', 'Skinny Love');
    const l = lastfm(T0, 'Birdy', 'Skinny Love');
    expect(counted([s, l])).toEqual([s.id, l.id].sort());
  });

  it('the same song ten minutes later', () => {
    const s = spotify(T0);
    const l = lastfm(T0 + 10 * MIN);
    expect(counted([s, l])).toEqual([s.id, l.id].sort());
  });
});

describe('short streams', () => {
  it('under 30 seconds never count and never pair, so the scrobble of that moment counts', () => {
    const skip = spotify(T0, undefined, undefined, 12_000);
    const l = lastfm(T0);
    expect(counted([skip, l])).toEqual([l.id]);
    expect(copyOf([skip, l])).toEqual({});
  });

  it('a skip then a full play: the scrobble pairs with the full play', () => {
    const skip = spotify(T0, undefined, undefined, 5_000);
    const full = spotify(T0 + 5_000, undefined, undefined, 219_000);
    const l = lastfm(T0 + 6_000);
    expect(counted([skip, full, l])).toEqual([full.id]);
  });
});
