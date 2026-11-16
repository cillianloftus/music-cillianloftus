import { handle } from '@astrojs/cloudflare/handler';
import { env } from 'cloudflare:workers';
import { enqueue, recountJobs } from './lib/jobs/queue';
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
import { linkAlbumsToSpotify, preferExplicitEditions } from './lib/spotify/link';
import { detectAnomalies } from './lib/review';
import { syncAllScrobbles } from './lib/scrobbles';
import { catalogueIndex } from './lib/listens/match';
import { rematchListens } from './lib/listens/store';
import { fillAlbumsFromDiscogs } from './lib/sources/discogs';
import { checkOfficialReleases } from './lib/official';
import { nudgeRatings, pushToUser, vapid } from './lib/nudge';
import { latestBackup, recordNightly, type TaskRun } from './lib/health';
import { rebuildAllGutConversions, rebuildStaleGutConversions } from './lib/gut-calibration';
import { mergeTwins } from './lib/twins';
import { rebuildAllInheritedScores } from './lib/inherited';

/**
 * Checks the library against MusicBrainz's official releases a little at a
 * time (src/lib/official.ts), only while no imports wait: MusicBrainz
 * allows one request a second, and the check beside a running import made
 * both go faster than that (503s, imports sent to the back). Once a pass
 * finds nothing left to look up, it rests for six hours.
 */
async function checkOfficial(): Promise<void> {
  const REST = 'official-check-resting';
  if (await env.CACHE.get(REST)) return;
  const busy = await env.DB.prepare(`SELECT 1 FROM job WHERE status IN ('queued', 'running') LIMIT 1`).first();
  if (busy) return;
  const lookups = await checkOfficialReleases({ budgetMs: 20_000 });
  if (lookups === 0) await env.CACHE.put(REST, '1', { expirationTtl: 6 * 3600 });
}

/**
 * A push to the owner's devices when the newest backup is over a day old:
 * the backup once failed for two days with nothing to show for it.
 */
async function warnIfBackupOverdue(): Promise<void> {
  const [backup, owner, keys] = [await latestBackup(), await ownerId(), vapid()];
  if (!owner || !keys || (backup && !backup.overdue)) return;
  await pushToUser(owner, {
    title: 'Backup overdue',
    body: backup ? `The newest is from ${backup.at.slice(0, 10)}. See Manage › Health.` : 'There is no backup at all. See Manage › Health.',
    tag: 'health',
    url: '/manage/health',
  }, keys);
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
  // Sixty a night, misses remembered (0077): the 5,700 unlinked on 15 Nov in about three months, rated ones first.
  await linkAlbumsToSpotify(spotifyFor(owner), { limit: 60 });
  // Albums linked to a clean edition, switched to the one as released (Kamikaze, 16 Nov).
  await preferExplicitEditions(spotifyFor(owner), { limit: 10 }).catch((error) => console.warn('Explicit check failed', error));
  // Then what Spotify knows about them: dates, lengths, ISRCs.
  await fillAlbumsFromSpotify(spotifyFor(owner), { budgetMs: 15_000 });
}

export default {
  fetch: handle,

  // Every minute: claim queued jobs and work through them, for up to four
  // minutes; ticks meanwhile find the runner's lease held and step aside.
  // Daily at 04:00 UTC: queue a backup, derive album genres, run the review rules.
  async scheduled(controller, _env, ctx) {
    ctx.waitUntil(
      (async () => {
        if (controller.cron === DAILY_BACKUP) {
          // Before tonight's: if last night's never landed, say so on the phone.
          await warnIfBackupOverdue().catch((error) => console.error('Backup check failed', error));
          await enqueue('backup', {});
          const runs: TaskRun[] = [];
          // Both are housekeeping; neither failing may hold up the jobs.
          for (const [name, task] of [
            ['Album genre derivation', deriveAlbumGenres],
            // After the genres: a song's conversion follows its artist and genres.
            ['Gut score conversions', rebuildAllGutConversions],
            // After them: versions borrow the scores the conversions set (0075).
            ['Borrowed scores for versions', rebuildAllInheritedScores],
            ['Review rules', detectAnomalies],
            // The kept job counts (0070) set from a real count, once a day.
            ['Job counts', recountJobs],
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
            const started = Date.now();
            try {
              await task();
              runs.push({ name, at: new Date(started).toISOString(), ok: true, ms: Date.now() - started });
            } catch (error) {
              console.error(`${name} failed`, error);
              const message = error instanceof Error ? error.message : String(error);
              runs.push({ name, at: new Date(started).toISOString(), ok: false, ms: Date.now() - started, error: message.slice(0, 500) });
            }
          }
          // What /manage/health shows of the night.
          await recordNightly(runs).catch((error) => console.error('Recording the night failed', error));
        }
        // First, and quick: a nudge for an unrated song playing now (src/lib/nudge.ts).
        await nudgeRatings().catch((error) => console.error('Rating nudges failed', error));
        // Gut conversions after a detailed rating (src/lib/gut-calibration.ts).
        await rebuildStaleGutConversions().catch((error) => console.error('Gut calibration failed', error));
        // Up to eleven minutes (an import started near the end still ends
        // inside a cron run's fifteen): one run holds the lease (runner.ts), so the
        // next minutes' ticks step aside rather than overlap. At four, the
        // queue sat idle between one run's end and the next tick's start.
        // An import is mostly waiting on MusicBrainz, so this is little CPU.
        await runJobs({ budgetMs: 11 * 60_000 });
        // Twin recordings already in the library (twins.ts), a batch a minute:
        // the ticks that step aside from the job run have the time.
        await mergeTwins({ budgetMs: 20_000 }).catch((error) => console.error('Twin merges failed', error));
        await checkOfficial().catch((error) => console.error('Official release check failed', error));
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
