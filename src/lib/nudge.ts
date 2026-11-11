/**
 * Rate what's playing: once a minute (the cron), for each listener who
 * turned notifications on, a look at what Spotify is playing. A song in
 * the library they have not rated yet gets a notification; tapping it
 * opens the song's rating page. Each new one replaces the last (one tag,
 * one topic), so the shade holds one nudge, not a pile.
 *
 * Cost: one D1 row to find who wants nudges, and per listener one KV read
 * and one Spotify request a minute; the library is only asked when the
 * song changes, a seek on spotify_id or isrc and one on rating.
 */

import { env } from 'cloudflare:workers';
import { MARKET, ReauthorizationRequired, SpotifyNotConfigured, spotifyFor, type SpotifyClient } from './spotify/client';
import { sendPush, type PushTarget, type Vapid } from './push/webpush';

/** The notification's tag on the device: one nudge at a time. */
export const NUDGE_TAG = 'rate-now';
const SITE = 'https://music.cillianloftus.com';

export interface Playing {
  spotifyId: string;
  isrc: string | null;
  title: string;
  artists: string[];
  art: string | null;
}

interface ApiCurrentlyPlaying {
  is_playing: boolean;
  currently_playing_type: string;
  item: {
    id: string;
    name: string;
    artists: { name: string }[];
    external_ids?: { isrc?: string };
    album: { images: { url: string; width: number | null }[] };
  } | null;
}

/** The track playing now, or null when nothing is (paused, a podcast, an ad). */
export async function playingNow(client: SpotifyClient): Promise<Playing | null> {
  const p = await client.get<ApiCurrentlyPlaying | undefined>(`/me/player/currently-playing?market=${MARKET}`);
  if (!p?.is_playing || p.currently_playing_type !== 'track' || !p.item) return null;
  const images = [...p.item.album.images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return {
    spotifyId: p.item.id,
    isrc: p.item.external_ids?.isrc?.toUpperCase() ?? null,
    title: p.item.name,
    artists: p.item.artists.map((a) => a.name),
    // The smallest at least 128 wide: a notification icon, not a cover.
    art: (images.find((i) => (i.width ?? 0) >= 128) ?? images.at(-1))?.url ?? null,
  };
}

/** The library's recording for a Spotify track, and whether this listener has rated it. */
export async function inLibrary(track: Pick<Playing, 'spotifyId' | 'isrc'>, userId: string): Promise<{ id: string; rated: boolean } | null> {
  const row = await env.DB.prepare(
    `SELECT id, EXISTS (SELECT 1 FROM rating x WHERE x.entity_type = 'recording' AND x.entity_id = m.id AND x.user_id = ?3) AS rated
     FROM (SELECT r.id FROM recording r WHERE r.spotify_id = ?1
           UNION ALL
           SELECT r.id FROM recording r WHERE ?2 IS NOT NULL AND r.isrc = ?2) m
     LIMIT 1`,
  )
    .bind(track.spotifyId, track.isrc, userId)
    .first<{ id: string; rated: number }>();
  return row ? { id: row.id, rated: row.rated === 1 } : null;
}

/** What the device shows. */
export function nudgeMessage(track: Playing, recordingId: string) {
  return {
    title: track.title,
    body: `${track.artists.join(', ')} · not rated yet`,
    icon: track.art,
    tag: NUDGE_TAG,
    url: `/edit/rate/recording/${recordingId}`,
  };
}

export function vapid(): Vapid | null {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  return publicKey && privateKey ? { publicKey, privateKey, subject: SITE } : null;
}

const pauseKey = (userId: string) => `nudge:pause:${userId}`;
const lastKey = (userId: string) => `nudge:last:${userId}`;

/** Seconds until five tomorrow morning, Irish time: "not today" lasts the night. */
export function secondsUntilMorning(now = new Date()): number {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(now)
    .split(':')
    .map(Number) as [number, number];
  const hours = (24 + 5 - h) % 24 || 24;
  return Math.max(60, hours * 3600 - m * 60);
}

export async function pauseNudges(userId: string): Promise<void> {
  await env.CACHE.put(pauseKey(userId), '1', { expirationTtl: secondsUntilMorning() });
}

/** Sends one message to every device of a listener; forgets devices the push service no longer knows. */
export async function pushToUser(userId: string, message: unknown, keys: Vapid, only?: string): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT endpoint, p256dh, auth FROM push_subscription WHERE user_id = ?1 AND (?2 IS NULL OR endpoint = ?2)`,
  )
    .bind(userId, only ?? null)
    .all<PushTarget>();
  let sent = 0;
  for (const target of results) {
    try {
      const status = await sendPush(target, message, keys, { ttl: 600, urgency: 'normal', topic: NUDGE_TAG });
      if (status === 404 || status === 410) {
        await env.DB.prepare('DELETE FROM push_subscription WHERE endpoint = ?').bind(target.endpoint).run();
      } else if (status < 300) sent++;
      else console.warn('Push refused', status, new URL(target.endpoint).host);
    } catch (error) {
      console.warn('Push failed', error);
    }
  }
  return sent;
}

/** One listener's minute. */
async function nudgeUser(userId: string, keys: Vapid): Promise<void> {
  if (await env.CACHE.get(pauseKey(userId))) return;
  let track: Playing | null;
  try {
    track = await playingNow(spotifyFor(userId));
  } catch (error) {
    if (error instanceof ReauthorizationRequired || error instanceof SpotifyNotConfigured) return;
    throw error;
  }
  if (!track) return;
  // The same song as last minute: already handled, either way.
  if ((await env.CACHE.get(lastKey(userId))) === track.spotifyId) return;
  await env.CACHE.put(lastKey(userId), track.spotifyId, { expirationTtl: 6 * 3600 });
  const recording = await inLibrary(track, userId);
  if (!recording || recording.rated) return;
  await pushToUser(userId, nudgeMessage(track, recording.id), keys);
}

/** The cron's minute: everyone with notifications on. */
export async function nudgeRatings(): Promise<void> {
  const keys = vapid();
  if (!keys) return;
  const { results } = await env.DB.prepare('SELECT DISTINCT user_id FROM push_subscription').all<{ user_id: string }>();
  for (const { user_id } of results) {
    await nudgeUser(user_id, keys).catch((error) => console.warn('Rating nudge failed', user_id, error));
  }
}
