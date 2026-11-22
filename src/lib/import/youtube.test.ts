import { describe, expect, it } from 'vitest';
import { youtubeSong, youtubeVideoId } from './youtube';

describe('youtubeVideoId', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtube.com/watch?list=PL123&v=dQw4w9WgXcQ&t=42', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=abc', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['  https://www.youtube.com/live/dQw4w9WgXcQ  ', 'dQw4w9WgXcQ'],
  ])('%s', (link, id) => expect(youtubeVideoId(link)).toBe(id));

  it.each(['https://www.youtube.com/playlist?list=PL123', 'https://example.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/short', 'not a link'])(
    'not a video: %s',
    (link) => expect(youtubeVideoId(link)).toBeNull(),
  );
});

describe('youtubeSong', () => {
  it('a YouTube Music upload: the channel is the artist', () => {
    expect(youtubeSong('Hit My Line', 'Logic - Topic')).toEqual({ artist: 'Logic', title: 'Hit My Line' });
  });

  it('a music video: "Artist - Song (Official Video)"', () => {
    expect(youtubeSong('Rick Astley - Never Gonna Give You Up (Official Music Video)', 'Rick Astley')).toEqual({
      artist: 'Rick Astley',
      title: 'Never Gonna Give You Up',
    });
    expect(youtubeSong('Quadeca – Baby Steps [Official Audio] | Out Now', 'Quadeca')).toEqual({ artist: 'Quadeca', title: 'Baby Steps' });
  });

  it('keeps brackets that belong to the song', () => {
    expect(youtubeSong('Logic - Hit My Line (feat. Someone) (Lyrics)', 'Lyric Channel')).toEqual({
      artist: 'Logic',
      title: 'Hit My Line (feat. Someone)',
    });
    expect(youtubeSong('Artist - Song (Live at Wembley)', 'Artist').title).toBe('Song (Live at Wembley)');
  });

  it('"ARTIST \'Song\' MV"', () => {
    expect(youtubeSong("NewJeans 'Super Shy' Official MV", 'HYBE LABELS')).toEqual({ artist: 'NewJeans', title: 'Super Shy' });
  });

  it('no artist in the title: the channel, less VEVO', () => {
    expect(youtubeSong('Baby One More Time (Official Video)', 'BritneySpearsVEVO')).toEqual({ artist: 'Britney Spears', title: 'Baby One More Time' });
    expect(youtubeSong('"Nasty"', 'Logic')).toEqual({ artist: 'Logic', title: 'Nasty' });
  });
});
