/**
 * fanart.tv (webservice.fanart.tv/v3/music): curated, high-resolution
 * artist pictures, found by MusicBrainz id so they are always the right
 * person. Square portraits ("artistthumb", 1000×1000) and wide backgrounds
 * ("artistbackground", 1920×1080), each with a like count the community
 * gives it. Needs a personal API key.
 */

type Fetcher = typeof fetch;
const API = 'https://webservice.fanart.tv/v3/music';

interface Art {
  url: string;
  likes?: string;
}

export interface FanartArtist {
  portraits: { url: string; likes: number }[];
  backgrounds: { url: string; likes: number }[];
  page: string;
}

const byLikes = (list: Art[] | undefined) =>
  (list ?? []).map((a) => ({ url: a.url.replace(/^http:/, 'https:'), likes: Number(a.likes ?? 0) })).sort((a, b) => b.likes - a.likes);

/** What fanart.tv has for an artist, or null when it has nothing. */
export async function fanartFor(key: string, mbid: string, fetcher: Fetcher = fetch): Promise<FanartArtist | null> {
  const res = await fetcher(`${API}/${mbid}?api_key=${encodeURIComponent(key)}`, { headers: { accept: 'application/json' } });
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) throw new Error('fanart.tv did not accept the API key.');
  if (!res.ok) throw new Error(`fanart.tv answered ${res.status}.`);
  const body = (await res.json()) as { artistthumb?: Art[]; artistbackground?: Art[] };
  const portraits = byLikes(body.artistthumb);
  const backgrounds = byLikes(body.artistbackground);
  if (!portraits.length && !backgrounds.length) return null;
  return { portraits, backgrounds, page: `https://fanart.tv/artist/${mbid}/` };
}

/** A key works if fanart.tv will look up a known artist with it (Radiohead). */
export async function checkKey(key: string, fetcher: Fetcher = fetch): Promise<void> {
  await fanartFor(key, 'a74b1b7f-71a5-4011-9441-d0b5e4122711', fetcher);
}
