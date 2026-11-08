/**
 * A recap, worked out from one stretch of listening. Pure: the loader
 * (load.ts) reads the listens and names; this counts.
 *
 * What counts is decided before this runs (listens/dedupe.ts): every
 * listen here is a counted play, one per moment of listening, whichever
 * services reported it. Streams under 30 seconds arrive separately, for
 * skip statistics only.
 *
 * Songs, artists and albums are keyed by name as the sources gave them
 * (normalised), so a song heard through Spotify and scrobbled under a
 * slightly different title is one song, and a song outside the catalogue
 * still counts. Genres and scores come from the catalogue, so they cover
 * the catalogued share of listening; the recap says how much that is.
 */

import { zoneOffset } from './range';

export interface RecapListen {
  /** Epoch ms, start. */
  at: number;
  /** Length listened; estimated when the source did not say. */
  ms: number;
  estimated: boolean;
  source: string;
  song: string;
  artist: string;
  album: string | null;
  genres: string[];
  /** The song's score, when rated. */
  score: number | null;
  /** The recording, when in the catalogue. */
  recording: string | null;
  skipped: boolean | null;
  shuffle: boolean | null;
  platform: string | null;
}

export interface RecapSkip {
  at: number;
  song: string;
  artist: string;
}

export interface RecapInput {
  listens: RecapListen[];
  /** Streams under 30 seconds in the range. */
  short: RecapSkip[];
  /** Songs and artists heard before the range began (for what was new). Null for all-time. */
  knownSongs: Set<string> | null;
  knownArtists: Set<string> | null;
  /** The range, local days: [from, to). */
  from: string;
  to: string;
  /** Copies left uncounted because another source had the same moment. */
  duplicates: number;
}

export interface Tally {
  key: string;
  plays: number;
  minutes: number;
}

export interface SongTally extends Tally {
  artist: string;
  recording: string | null;
  score: number | null;
  /** First heard ever, within this range. */
  isNew: boolean;
}

export interface ArtistTally extends Tally {
  songs: number;
  topSong: string;
  isNew: boolean;
}

export interface AlbumTally extends Tally {
  artist: string;
}

export interface Bucket {
  /** Local day the bucket starts. */
  from: string;
  minutes: number;
  plays: number;
}

export interface Recap {
  totals: {
    minutes: number;
    plays: number;
    songs: number;
    artists: number;
    albums: number;
    /** Days with any listening, of the range's days. */
    activeDays: number;
    days: number;
    /** Share of minutes worked out from a track's length, not reported. */
    estimatedShare: number;
  };
  first: number | null;
  last: number | null;
  songs: SongTally[];
  artists: ArtistTally[];
  albums: AlbumTally[];
  genres: Tally[];
  /** Share of minutes on songs with genres known. */
  genreCoverage: number;
  /** Minutes by local hour, 0–23. */
  hours: number[];
  /** Minutes by weekday, Monday first. */
  weekdays: number[];
  /** Day, week or month buckets across the range, by its length. */
  series: { unit: 'day' | 'week' | 'month'; buckets: Bucket[] };
  biggestDay: { day: string; minutes: number; plays: number; song: string } | null;
  streak: { from: string; to: string; days: number } | null;
  session: { start: number; end: number; minutes: number; plays: number } | null;
  repeat: { song: string; artist: string; day: string; plays: number } | null;
  /** Late night: midnight to five. */
  lateShare: number;
  discoveries: { songs: number; artists: number; songShare: number } | null;
  skips: { streams: number; skipped: number; rate: number } | null;
  shuffleShare: number | null;
  platforms: Tally[];
  sources: { source: string; plays: number }[];
  duplicates: number;
  ratings: {
    /** Share of plays on songs with a score. */
    ratedShare: number;
    /** Score of what was played, weighted by plays. */
    average: number | null;
    /** Played most, not rated: worth rating. */
    unrated: SongTally[];
    /** Best scored of what was played. */
    best: SongTally[];
  };
  /** For ranges over two months: each month's most played song. */
  months: { month: string; song: SongTally; minutes: number }[];
}

const MIN = 60_000;
const round = (n: number) => Math.round(n * 10) / 10;

/** Local day, hour and weekday of an instant; offsets cached by hour, as most listens share them. */
function clock() {
  const offsets = new Map<number, number>();
  return (at: number) => {
    const hourKey = Math.floor(at / 3_600_000);
    let offset = offsets.get(hourKey);
    if (offset === undefined) {
      offset = zoneOffset(at);
      offsets.set(hourKey, offset);
    }
    const local = new Date(at + offset * MIN);
    return {
      day: local.toISOString().slice(0, 10),
      hour: local.getUTCHours(),
      // getUTCDay: Sunday 0. Monday first here.
      weekday: (local.getUTCDay() + 6) % 7,
    };
  };
}

function tallyBy<T extends { key: string }>(entries: Iterable<T>, plays: (t: T) => number): T[] {
  return [...entries].sort((a, b) => plays(b) - plays(a) || a.key.localeCompare(b.key));
}

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Monday of the week a day is in. */
function weekOf(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  const weekday = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - weekday * 86_400_000).toISOString().slice(0, 10);
}

export function buildRecap(input: RecapInput): Recap {
  const { listens, short, knownSongs, knownArtists, from, to } = input;
  const local = clock();
  const days = daysBetween(from, to);

  const songs = new Map<string, SongTally & { artistKey: string }>();
  const artists = new Map<string, ArtistTally & { songSet: Set<string>; songPlays: Map<string, number> }>();
  const albums = new Map<string, AlbumTally>();
  const genres = new Map<string, Tally>();
  const platforms = new Map<string, Tally>();
  const sources = new Map<string, number>();
  const hours = Array<number>(24).fill(0);
  const weekdays = Array<number>(7).fill(0);
  const byDay = new Map<string, { minutes: number; plays: number; songs: Map<string, number> }>();
  const perSongDay = new Map<string, number>();
  const byMonth = new Map<string, Map<string, { plays: number; minutes: number }>>();

  let minutes = 0;
  let estimatedMinutes = 0;
  let genreMinutes = 0;
  let lateMinutes = 0;
  let shuffleOn = 0;
  let shuffleKnown = 0;
  let ratedPlays = 0;
  let scoreSum = 0;

  const sorted = [...listens].sort((a, b) => a.at - b.at);
  for (const l of sorted) {
    const m = l.ms / MIN;
    const when = local(l.at);
    minutes += m;
    if (l.estimated) estimatedMinutes += m;
    hours[when.hour]! += m;
    weekdays[when.weekday]! += m;
    if (when.hour < 5) lateMinutes += m;

    const song = songs.get(l.song) ?? { key: l.song, artist: l.artist, artistKey: l.artist, plays: 0, minutes: 0, recording: null, score: null, isNew: false };
    song.plays += 1;
    song.minutes += m;
    song.recording ??= l.recording;
    song.score ??= l.score;
    songs.set(l.song, song);

    const artist = artists.get(l.artist) ?? { key: l.artist, plays: 0, minutes: 0, songs: 0, topSong: l.song, isNew: false, songSet: new Set(), songPlays: new Map() };
    artist.plays += 1;
    artist.minutes += m;
    artist.songSet.add(l.song);
    artist.songPlays.set(l.song, (artist.songPlays.get(l.song) ?? 0) + 1);
    artists.set(l.artist, artist);

    if (l.album) {
      const album = albums.get(l.album) ?? { key: l.album, artist: l.artist, plays: 0, minutes: 0 };
      album.plays += 1;
      album.minutes += m;
      albums.set(l.album, album);
    }
    if (l.genres.length) {
      genreMinutes += m;
      // A song in three genres gives each its full minutes: genres overlap.
      for (const g of l.genres) {
        const t = genres.get(g) ?? { key: g, plays: 0, minutes: 0 };
        t.plays += 1;
        t.minutes += m;
        genres.set(g, t);
      }
    }
    if (l.platform) {
      const t = platforms.get(l.platform) ?? { key: l.platform, plays: 0, minutes: 0 };
      t.plays += 1;
      t.minutes += m;
      platforms.set(l.platform, t);
    }
    sources.set(l.source, (sources.get(l.source) ?? 0) + 1);
    if (l.shuffle !== null) {
      shuffleKnown += 1;
      if (l.shuffle) shuffleOn += 1;
    }
    if (l.score !== null) {
      ratedPlays += 1;
      scoreSum += l.score;
    }

    const day = byDay.get(when.day) ?? { minutes: 0, plays: 0, songs: new Map() };
    day.minutes += m;
    day.plays += 1;
    day.songs.set(l.song, (day.songs.get(l.song) ?? 0) + 1);
    byDay.set(when.day, day);
    const sd = `${l.song}\u0000${when.day}`;
    perSongDay.set(sd, (perSongDay.get(sd) ?? 0) + 1);

    const month = when.day.slice(0, 7);
    const mm = byMonth.get(month) ?? new Map();
    const ms = mm.get(l.song) ?? { plays: 0, minutes: 0 };
    ms.plays += 1;
    ms.minutes += m;
    mm.set(l.song, ms);
    byMonth.set(month, mm);
  }

  // What was new: never heard before this range.
  if (knownSongs) for (const s of songs.values()) s.isNew = !knownSongs.has(s.key);
  if (knownArtists) for (const a of artists.values()) a.isNew = !knownArtists.has(a.key);
  for (const a of artists.values()) {
    a.songs = a.songSet.size;
    a.topSong = [...a.songPlays].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]![0];
  }

  const songList = tallyBy(songs.values(), (s) => s.plays * 1e6 + s.minutes).map(({ artistKey: _a, ...s }) => ({ ...s, minutes: round(s.minutes) }));
  const artistList = tallyBy(artists.values(), (a) => a.minutes).map(({ songSet: _s, songPlays: _p, ...a }) => ({ ...a, minutes: round(a.minutes) }));
  const albumList = tallyBy(albums.values(), (a) => a.minutes).map((a) => ({ ...a, minutes: round(a.minutes) }));
  const genreList = tallyBy(genres.values(), (g) => g.minutes).map((g) => ({ ...g, minutes: round(g.minutes) }));

  // The series: days for up to three months, weeks up to two years, then months.
  const unit: 'day' | 'week' | 'month' = days <= 92 ? 'day' : days <= 731 ? 'week' : 'month';
  const keyOf = (day: string) => (unit === 'day' ? day : unit === 'week' ? weekOf(day) : `${day.slice(0, 7)}-01`);
  const buckets = new Map<string, Bucket>();
  if (days <= 3660) {
    for (let d = from; d < to; d = nextDay(d)) {
      const k = keyOf(d);
      if (!buckets.has(k)) buckets.set(k, { from: k, minutes: 0, plays: 0 });
    }
  }
  for (const [day, v] of byDay) {
    const k = keyOf(day);
    const b = buckets.get(k) ?? { from: k, minutes: 0, plays: 0 };
    b.minutes += v.minutes;
    b.plays += v.plays;
    buckets.set(k, b);
  }
  const series = { unit, buckets: [...buckets.values()].sort((a, b) => a.from.localeCompare(b.from)).map((b) => ({ ...b, minutes: round(b.minutes) })) };

  const biggest = [...byDay].sort((a, b) => b[1].minutes - a[1].minutes || a[0].localeCompare(b[0]))[0];
  const biggestDay = biggest
    ? {
        day: biggest[0],
        minutes: round(biggest[1].minutes),
        plays: biggest[1].plays,
        song: [...biggest[1].songs].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0],
      }
    : null;

  // The longest run of days in a row with any listening.
  let streak: Recap['streak'] = null;
  const activeDays = [...byDay.keys()].sort();
  for (let i = 0; i < activeDays.length; ) {
    let j = i;
    while (j + 1 < activeDays.length && activeDays[j + 1] === nextDay(activeDays[j]!)) j++;
    const length = j - i + 1;
    if (!streak || length > streak.days) streak = { from: activeDays[i]!, to: activeDays[j]!, days: length };
    i = j + 1;
  }

  // Sessions: listening with no gap over half an hour.
  let session: Recap['session'] = null;
  let current: { start: number; end: number; ms: number; plays: number } | null = null;
  for (const l of sorted) {
    if (current && l.at - current.end <= 30 * MIN) {
      current.end = Math.max(current.end, l.at + l.ms);
      current.ms += l.ms;
      current.plays += 1;
    } else {
      current = { start: l.at, end: l.at + l.ms, ms: l.ms, plays: 1 };
    }
    if (!session || current.ms / MIN > session.minutes) session = { start: current.start, end: current.end, minutes: round(current.ms / MIN), plays: current.plays };
  }

  const repeatTop = [...perSongDay].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const repeat =
    repeatTop && repeatTop[1] >= 3
      ? { song: repeatTop[0].split('\u0000')[0]!, artist: songs.get(repeatTop[0].split('\u0000')[0]!)!.artist, day: repeatTop[0].split('\u0000')[1]!, plays: repeatTop[1] }
      : null;

  const newSongs = songList.filter((s) => s.isNew);
  const discoveries = knownSongs
    ? {
        songs: newSongs.length,
        artists: artistList.filter((a) => a.isNew).length,
        songShare: listens.length ? newSongs.reduce((n, s) => n + s.plays, 0) / listens.length : 0,
      }
    : null;

  // Skips: the export's own flag, or a stream cut under 30 seconds.
  const exportListens = listens.filter((l) => l.source === 'spotify_export');
  const skipped = exportListens.filter((l) => l.skipped).length + short.length;
  const streams = exportListens.length + short.length;
  const skips = streams > 0 ? { streams, skipped, rate: skipped / streams } : null;

  const played = songList.filter((s) => s.plays > 0);
  const months =
    days > 62
      ? [...byMonth]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([month, m]) => {
            const [key, v] = [...m].sort((a, b) => b[1].plays - a[1].plays || b[1].minutes - a[1].minutes || a[0].localeCompare(b[0]))[0]!;
            const total = [...m.values()].reduce((n, x) => n + x.minutes, 0);
            return { month, song: { ...songList.find((s) => s.key === key)!, plays: v.plays, minutes: round(v.minutes) }, minutes: round(total) };
          })
      : [];

  return {
    totals: {
      minutes: round(minutes),
      plays: listens.length,
      songs: songs.size,
      artists: artists.size,
      albums: albums.size,
      activeDays: byDay.size,
      days,
      estimatedShare: minutes > 0 ? estimatedMinutes / minutes : 0,
    },
    first: sorted[0]?.at ?? null,
    last: sorted.at(-1)?.at ?? null,
    songs: songList,
    artists: artistList,
    albums: albumList,
    genres: genreList,
    genreCoverage: minutes > 0 ? genreMinutes / minutes : 0,
    hours: hours.map(round),
    weekdays: weekdays.map(round),
    series,
    biggestDay,
    streak,
    session,
    repeat,
    lateShare: minutes > 0 ? lateMinutes / minutes : 0,
    discoveries,
    skips,
    shuffleShare: shuffleKnown > 0 ? shuffleOn / shuffleKnown : null,
    platforms: tallyBy(platforms.values(), (p) => p.minutes).map((p) => ({ ...p, minutes: round(p.minutes) })),
    sources: [...sources].map(([source, plays]) => ({ source, plays })).sort((a, b) => b.plays - a.plays),
    duplicates: input.duplicates,
    ratings: {
      ratedShare: listens.length ? ratedPlays / listens.length : 0,
      average: ratedPlays ? scoreSum / ratedPlays : null,
      unrated: played.filter((s) => s.score === null && s.recording !== null).slice(0, 10),
      best: [...played].filter((s) => s.score !== null).sort((a, b) => b.score! - a.score! || b.plays - a.plays).slice(0, 10),
    },
    months,
  };
}
