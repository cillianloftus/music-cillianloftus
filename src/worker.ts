import { handle } from '@astrojs/cloudflare/handler';
import { env } from 'cloudflare:workers';
import { enqueue } from './lib/jobs/queue';
import { runJobs } from './lib/jobs/runner';
import { fetchArtistImages } from './lib/artist-images';
import { enrichArtists } from './lib/artists';
import { fillCreditsFromGenius, fillSongLinks } from './lib/genius';
import { fillAlbumsFromSpotify } from './lib/spotify/fill';
import { fillAlbumSoundFromDeezer, fillAlbumsFromDeezer } from './lib/sources/deezer';
import { fillPopularity } from './lib/popularity';
import { fillArtistsFromWiki } from './lib/sources/wikipedia';
import { fillAlbumsMoreFromMusicBrainz } from './lib/sources/musicbrainz-more';
import { ownerId } from './lib/auth/user';
import { deriveAlbumGenres } from './lib/genres';
import { connection, spotifyFor } from './lib/spotify/client';
import { linkAlbumsToSpotify } from './lib/spotify/link';
import { detectAnomalies } from './lib/review';
import { syncAllScrobbles } from './lib/scrobbles';
import { catalogueIndex } from './lib/listens/match';
import { rematchListens } from './lib/listens/store';
import { fillAlbumsFromDiscogs } from './lib/sources/discogs';
import { checkOfficialReleases } from './lib/official';
import { nudgeRatings } from './lib/nudge';

/**
 * Checks the library against MusicBrainz's official releases a little at a
 * time (src/lib/official.ts): a short slice while imports are also using
 * MusicBrainz, a longer one when they are not. Once a pass finds nothing
 * left to look up, it rests for six hours.
 */
async function checkOfficial(): Promise<void> {
  const REST = 'official-check-resting';
  if (await env.CACHE.get(REST)) return;
  const busy = await env.DB.prepare(`SELECT 1 FROM job WHERE status IN ('queued', 'running') LIMIT 1`).first();
  const lookups = await checkOfficialReleases({ budgetMs: busy ? 6_000 : 20_000 });
  if (lookups === 0) await env.CACHE.put(REST, '1', { expirationTtl: 6 * 3600 });
}

/** Must match the daily entry in wrangler.jsonc triggers.crons. */
const DAILY_BACKUP = '0 4 * * *';

/** Pictures for a few enriched artists that have none yet, each night. */
async function picturesForArtistsWithout(): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT a.id FROM artist a
     WHERE (a.wikidata_id IS NOT NULL OR a.spotify_id IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM artist_image i WHERE i.artist_id = a.id)
     LIMIT 8`,
  ).all<{ id: string }>();
  for (const { id } of results) await fetchArtistImages(id).catch((error) => console.warn('Pictures failed', id, error));
}

/** Finds Spotify albums for anything without a link, if Spotify is connected. */
async function linkSpotifyAlbums(): Promise<void> {
  const owner = await ownerId();
  if (!owner || !(await connection(owner))) return;
  await linkAlbumsToSpotify(spotifyFor(owner), { limit: 25 });
  // Then what Spotify knows about them: dates, lengths, ISRCs.
  await fillAlbumsFromSpotify(spotifyFor(owner), { budgetMs: 15_000 });
}

export default {
  fetch: handle,

  // Every minute: claim queued jobs and work through them. A scheduled
  // invocation may run for minutes, but stopping well inside the cron
  // interval keeps ticks from piling up behind each other.
  // Daily at 04:00 UTC: queue a backup, derive album genres, run the review rules.
  async scheduled(controller, _env, ctx) {
    ctx.waitUntil(
      (async () => {
        if (controller.cron === DAILY_BACKUP) {
          await enqueue('backup', {});
          // Both are housekeeping; neither failing may hold up the jobs.
          for (const [name, task] of [
            ['Album genre derivation', deriveAlbumGenres],
            ['Review rules', detectAnomalies],
            ['Artist details', () => enrichArtists({ budgetMs: 20_000 })],
            ['Awards, labels and influences from Wikidata', () => fillArtistsFromWiki({ budgetMs: 15_000 })],
            ['Artist pictures', picturesForArtistsWithout],
            ['Spotify album links', linkSpotifyAlbums],
            ['Writing credits from Genius', () => fillCreditsFromGenius({ budgetMs: 20_000 })],
            ['Samples and interpolations from Genius', () => fillSongLinks({ budgetMs: 15_000 })],
            ['Labels and barcodes from Deezer', () => fillAlbumsFromDeezer({ budgetMs: 15_000 })],
            ['Tempo and loudness from Deezer', () => fillAlbumSoundFromDeezer({ budgetMs: 20_000 })],
            ['Popularity from ListenBrainz', () => fillPopularity({ budgetMs: 15_000 })],
            ['Track genres, labels and lists from MusicBrainz', () => fillAlbumsMoreFromMusicBrainz({ budgetMs: 25_000 })],
            // Each does nothing until its key is pasted on /manage/connections.
            ['Scrobbles from Last.fm and ListenBrainz', () => syncAllScrobbles({ budgetMs: 25_000 })],
            ['Release details from Discogs', () => fillAlbumsFromDiscogs({ budgetMs: 25_000 })],
            // Listens of tracks imported since they were heard join their recordings.
            ['Listens matched to the catalogue', async () => rematchListens(await catalogueIndex())],
            // Planner statistics kept current as the library grows. Without
            // them SQLite guessed, and walked an artist's credits through an
            // index on entity_type (62,000 rows for 2,000). Only tables whose
            // statistics have drifted are looked at again.
            ['Planner statistics', async () => void (await env.DB.exec('PRAGMA optimize'))],
          ] as const) {
            try {
              await task();
            } catch (error) {
              console.error(`${name} failed`, error);
            }
          }
        }
        // First, and quick: a nudge for an unrated song playing now (src/lib/nudge.ts).
        await nudgeRatings().catch((error) => console.error('Rating nudges failed', error));
        await runJobs({ budgetMs: 50_000 });
        await checkOfficial().catch((error) => console.error('Official release check failed', error));
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
