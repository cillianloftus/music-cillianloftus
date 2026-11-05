/**
 * setlist.fm (api.setlist.fm/rest/1.0): an artist's recent shows and the
 * songs they play most, found by MusicBrainz artist id, so the match is
 * exact. Needs an API key; the limit is a couple of requests a second and
 * a few thousand a day, so results are cached for days.
 */

type Fetcher = typeof fetch;
const API = 'https://api.setlist.fm/rest/1.0';

export interface Show {
  date: string;
  venue: string;
  city: string;
  country: string;
  tour: string | null;
  songs: number;
  url: string;
}

export interface LiveSummary {
  shows: Show[];
  /** Songs by how many of the fetched shows they were in. */
  favourites: { title: string; shows: number; cover: boolean }[];
  /** How many shows the favourites are counted over. */
  counted: number;
  /** setlist.fm's total for the artist. */
  total: number;
  url: string | null;
}

interface RawSetlist {
  eventDate: string;
  url: string;
  artist?: { url?: string };
  tour?: { name: string };
  venue: { name: string; city: { name: string; country: { name: string } } };
  sets: { set: { song?: { name: string; tape?: boolean; cover?: { name: string } }[] }[] };
}

async function get<T>(key: string, path: string, fetcher: Fetcher): Promise<T | null> {
  const res = await fetcher(`${API}${path}`, { headers: { accept: 'application/json', 'x-api-key': key, 'user-agent': 'music.cillianloftus.com' } });
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) throw new Error('setlist.fm did not accept the API key.');
  if (!res.ok) throw new Error(`setlist.fm answered ${res.status}.`);
  return (await res.json()) as T;
}

/** A key works if setlist.fm will look up a known artist with it. */
export async function checkKey(key: string, fetcher: Fetcher = fetch): Promise<void> {
  // Radiohead's MusicBrainz id.
  await get(key, '/artist/a74b1b7f-71a5-4011-9441-d0b5e4122711', fetcher);
}

/** dd-MM-yyyy to yyyy-MM-dd. */
const isoDate = (d: string) => d.split('-').reverse().join('-');

export async function liveSummary(key: string, artistMbid: string, { pages = 2 } = {}, fetcher: Fetcher = fetch): Promise<LiveSummary | null> {
  const lists: RawSetlist[] = [];
  let total = 0;
  for (let p = 1; p <= pages; p++) {
    const body = await get<{ setlist: RawSetlist[]; total: number }>(key, `/artist/${artistMbid}/setlists?p=${p}`, fetcher);
    if (!body) break;
    total = body.total;
    lists.push(...body.setlist);
    if (lists.length >= total) break;
    // Two requests a second at most.
    if (p < pages) await new Promise((r) => setTimeout(r, 600));
  }
  if (lists.length === 0) return null;

  const songsOf = (s: RawSetlist) => s.sets.set.flatMap((set) => set.song ?? []).filter((song) => song.name && !song.tape);
  const counts = new Map<string, { title: string; shows: number; cover: boolean }>();
  const played = lists.filter((s) => songsOf(s).length > 0);
  for (const show of played) {
    const seen = new Set<string>();
    for (const song of songsOf(show)) {
      const key = song.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = counts.get(key) ?? { title: song.name, shows: 0, cover: Boolean(song.cover) };
      entry.shows += 1;
      counts.set(key, entry);
    }
  }
  return {
    shows: lists.slice(0, 5).map((s) => ({
      date: isoDate(s.eventDate),
      venue: s.venue.name,
      city: s.venue.city.name,
      country: s.venue.city.country.name,
      tour: s.tour?.name ?? null,
      songs: songsOf(s).length,
      url: s.url,
    })),
    favourites: [...counts.values()].sort((a, b) => b.shows - a.shows || a.title.localeCompare(b.title)).slice(0, 10),
    counted: played.length,
    total,
    url: lists[0]?.artist?.url ?? null,
  };
}
