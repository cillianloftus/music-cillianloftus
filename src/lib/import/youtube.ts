/**
 * A YouTube link as a song: the video's title and channel (YouTube's
 * oEmbed, no key), the artist and title read out of them, and that song
 * found on Spotify, whose album is then imported as from a Spotify link.
 * Only what the song is comes from YouTube; never its audio (audio is
 * Cillian's own files only).
 */

import { MARKET, type SpotifyClient } from '../spotify/client';
import { listenTrack } from '../listens/keys';
import { pickAlbum, type SpotifyTrackFound } from './played';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** The video a YouTube or YouTube Music link points at, or null. */
export function youtubeVideoId(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v') ?? /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(url.pathname)?.[1] ?? null;
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

/** Words in a video title that are about the video, not the song. */
const NOISE =
  /\b(official|video|audio|lyrics?|lyric video|visuali[sz]er|music video|mv|m\/v|hd|hq|4k|explicit|clean|full song|performance video|color coded|sub(?:bed|titles)?|eng|español)\b/i;

/**
 * The song a video names. A YouTube Music upload's channel is "Artist -
 * Topic" and its title the song's; a music video is usually "Artist -
 * Song (Official Video)", or "ARTIST 'Song' MV"; otherwise the channel is
 * taken for the artist.
 */
export function youtubeSong(title: string, channel: string): { artist: string; title: string } {
  let text = title
    .replace(/\s*[([]([^)\]]*)[)\]]/g, (match, inner: string) => (NOISE.test(inner) ? '' : match))
    .replace(/\s+[|｜].*$/, '')
    .replace(/\s+(?:official\s+)?(?:music\s+)?(?:video|audio|mv|m\/v|lyrics?)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const topic = /^(.+?) - Topic$/.exec(channel.trim());
  if (topic) return { artist: topic[1]!, title: text };
  const quoted = /^(.+?)\s+["'“‘](.+?)["'”’](?:\s|$)/.exec(text);
  if (quoted) return { artist: quoted[1]!.trim(), title: quoted[2]!.trim() };
  const dash = /^(.+?)\s+[-–—]\s+(.+)$/.exec(text);
  if (dash) return { artist: dash[1]!.trim(), title: dash[2]!.replace(/^["'“‘](.+)["'”’]$/, '$1').trim() };
  text = text.replace(/^["'“‘](.+)["'”’]$/, '$1');
  // "BritneySpearsVEVO": VEVO channels run the name together.
  const vevo = /^(\S+)VEVO$/i.exec(channel.trim());
  const artist = vevo ? vevo[1]!.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2') : channel.replace(/\s*(?:VEVO|Official)$/i, '');
  return { artist: artist.trim(), title: text };
}

/** The video's title and channel, from YouTube's oEmbed. Null when the video is private, gone, or not there. */
export async function youtubeVideo(id: string): Promise<{ title: string; channel: string } | null> {
  const params = new URLSearchParams({ url: `https://www.youtube.com/watch?v=${id}`, format: 'json' });
  const response = await fetch(`https://www.youtube.com/oembed?${params}`).catch(() => null);
  if (!response?.ok) return null;
  const data = (await response.json().catch(() => null)) as { title?: string; author_name?: string } | null;
  return data?.title && data.author_name ? { title: data.title, channel: data.author_name } : null;
}

/** Search terms cannot carry quotes or field syntax. */
const term = (value: string) => value.replace(/["':]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The song on Spotify, on its artist's own album (pickAlbum's rules):
 * searched by field, then loosely (a channel name a little off the
 * artist's), the same rules deciding either way. Null when neither finds it.
 */
export async function spotifySongFor(spotify: SpotifyClient, song: { artist: string; title: string }): Promise<SpotifyTrackFound | null> {
  const want = listenTrack(song);
  const bare = song.title.replace(/\s*[([](?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]|\s+(?:feat\.?|ft\.?|featuring)\s.+$/giu, '');
  for (const q of [`track:${term(bare)} artist:${term(song.artist)}`, `${term(song.artist)} ${term(bare)}`]) {
    const params = new URLSearchParams({ q, type: 'track', limit: '10', market: MARKET });
    const { tracks } = await spotify.get<{ tracks: { items: SpotifyTrackFound[] } }>(`/search?${params}`);
    const album = pickAlbum(want, tracks.items);
    if (album) return tracks.items.find((t) => t.album.id === album.id) ?? null;
  }
  return null;
}
