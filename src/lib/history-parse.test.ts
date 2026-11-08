import { describe, expect, it } from 'vitest';
import { collectHistory, isAudioHistory, type ParsedPlay, type ParsedTrack } from './history-parse';
import { playsRequest } from './history';

const URI = 'spotify:track:4uLU6hMCjMI75M1A2tKUQC';
const entry = (overrides: Record<string, unknown> = {}) => ({
  ts: '2024-03-01T21:14:05Z',
  ms_played: 215000,
  master_metadata_track_name: 'Never Gonna Give You Up',
  master_metadata_album_artist_name: 'Rick Astley',
  master_metadata_album_album_name: 'Whenever You Need Somebody',
  spotify_track_uri: URI,
  episode_name: null,
  ...overrides,
});

describe('collectHistory', () => {
  it('keeps every music stream, short ones too, and each track once', () => {
    const tracks = new Map<string, ParsedTrack>();
    const plays: ParsedPlay[] = [];
    const counted = collectHistory(
      [
        entry(),
        entry({ ts: '2024-03-02T08:00:00Z' }),
        entry({ ms_played: 4000 }), // a skip
        entry({ spotify_track_uri: null, master_metadata_track_name: null, episode_name: 'A podcast' }),
        entry({ ts: 'not a date' }),
      ],
      tracks,
      plays,
    );
    expect(counted).toBe(3);
    expect([...tracks.values()]).toEqual([{ uri: URI, name: 'Never Gonna Give You Up', artist: 'Rick Astley', album: 'Whenever You Need Somebody' }]);
    // Spotify stamps the end; played_at is the start.
    expect(plays.map((p) => p.played_at)).toEqual(['2024-03-01T21:10:30.000Z', '2024-03-02T07:56:25.000Z', '2024-03-01T21:14:01.000Z']);
  });

  it('keeps what the export says about each stream, but not the IP address', () => {
    const plays: ParsedPlay[] = [];
    collectHistory(
      [entry({ platform: 'Android OS 9 API 28 (samsung, SM-G950F)', conn_country: 'IE', ip_addr: '1.2.3.4', skipped: true, shuffle: false, offline: false, incognito_mode: false, reason_start: 'clickrow', reason_end: 'fwdbtn' })],
      new Map(),
      plays,
    );
    expect(plays[0]).toEqual({
      uri: URI,
      played_at: '2024-03-01T21:10:30.000Z',
      ms_played: 215000,
      skipped: true,
      shuffle: false,
      offline: false,
      incognito: false,
      platform: 'android',
      country: 'IE',
      reason_start: 'clickrow',
      reason_end: 'fwdbtn',
    });
    expect(JSON.stringify(plays)).not.toContain('1.2.3.4');
  });

  it('produces plays the server accepts', () => {
    const plays: ParsedPlay[] = [];
    collectHistory([entry()], new Map(), plays);
    expect(playsRequest.safeParse({ plays }).success).toBe(true);
  });

  it('refuses a file that is not a history', () => {
    expect(() => collectHistory({ not: 'an array' }, new Map(), [])).toThrow();
  });

  it('picks the audio history out of the export', () => {
    expect(isAudioHistory('Spotify Extended Streaming History/Streaming_History_Audio_2021-2023_0.json')).toBe(true);
    expect(isAudioHistory('Spotify Extended Streaming History/Streaming_History_Video_2021-2023.json')).toBe(false);
    expect(isAudioHistory('MyData/endsong_3.json')).toBe(true);
  });
});
