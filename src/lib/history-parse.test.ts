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
  it('keeps music plays of 30 seconds or more, and each track once', () => {
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
    expect(counted).toBe(2);
    expect([...tracks.values()]).toEqual([{ uri: URI, name: 'Never Gonna Give You Up', artist: 'Rick Astley', album: 'Whenever You Need Somebody' }]);
    expect(plays.map((p) => p.played_at)).toEqual(['2024-03-01T21:14:05Z', '2024-03-02T08:00:00Z']);
  });

  it('produces plays the server accepts', () => {
    const plays: ParsedPlay[] = [];
    collectHistory([entry()], new Map(), plays);
    const batch = plays.map((p) => ({ recording_id: 'a1', played_at: p.played_at, ms_played: p.ms_played }));
    expect(playsRequest.safeParse({ plays: batch }).success).toBe(true);
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
