import type { APIRoute } from 'astro';
import { enqueue } from '../../../lib/jobs/queue';
import { kickJobs } from '../../../lib/jobs/runner';
import { parseMbInput } from '../../../lib/musicbrainz/input';
import { parseSpotifyInput, type SpotifyTarget } from '../../../lib/spotify/album';
import { spotifySongFor, youtubeSong, youtubeVideo, youtubeVideoId } from '../../../lib/import/youtube';
import { connection, spotifyFor } from '../../../lib/spotify/client';
import { ownerId } from '../../../lib/auth/user';

class Unfound extends Error {}

/**
 * A YouTube video as the Spotify track it is (import/youtube.ts), so it
 * imports as that track's album. Throws Unfound with what went wrong.
 */
async function fromYouTube(videoId: string): Promise<{ target: SpotifyTarget; label: string }> {
  const video = await youtubeVideo(videoId);
  if (!video) throw new Unfound('YouTube would not say what that video is: it may be private or gone.');
  const song = youtubeSong(video.title, video.channel);
  const owner = await ownerId();
  if (!owner || !(await connection(owner))) throw new Unfound('Finding a YouTube video’s song needs Spotify connected (Manage → Spotify).');
  const track = await spotifySongFor(spotifyFor(owner), song);
  if (!track) throw new Unfound(`“${song.title}” by ${song.artist} is not on Spotify under that name. Manual entry takes anything.`);
  return { target: { kind: 'track', id: track.id }, label: `${track.name} · ${track.album.name}` };
}

/**
 * Queues an import. The cron would pick it up within a minute; starting
 * the runner after responding makes a single album land in seconds.
 */
export const POST: APIRoute = async ({ request, redirect, locals }) => {
  const form = await request.formData();
  const input = form.get('source')?.toString() ?? '';
  const target = parseMbInput(input);
  const spotify = target ? null : parseSpotifyInput(input);
  const video = target || spotify ? null : youtubeVideoId(input);

  // The import page posts with fetch and keeps the person on the page,
  // watching the job in a small tray; a plain form post goes to the jobs page.
  const wantsJson = request.headers.get('accept')?.includes('application/json');
  let jobId: string;
  let label: string;
  if (target) {
    jobId = await enqueue('import_release', { source: 'musicbrainz', target });
    label = 'MusicBrainz release';
  } else if (spotify) {
    jobId = await enqueue('import_release', { source: 'spotify', target: spotify });
    label = 'Spotify album';
  } else if (video) {
    try {
      const found = await fromYouTube(video);
      jobId = await enqueue('import_release', { source: 'spotify', target: found.target, label: found.label });
      label = found.label;
    } catch (error) {
      const message = error instanceof Unfound ? error.message : 'YouTube or Spotify could not be reached. Try again shortly.';
      if (!(error instanceof Unfound)) console.error('YouTube import failed', error);
      if (wantsJson) return Response.json({ error: message }, { status: 422 });
      return redirect(`/manage/import?${new URLSearchParams({ error: 'youtube', why: message, source: input })}`, 303);
    }
  } else {
    if (wantsJson) return Response.json({ error: 'That is not a MusicBrainz, Spotify or YouTube link.' }, { status: 422 });
    return redirect(`/manage/import?error=unrecognised&source=${encodeURIComponent(input)}`, 303);
  }
  kickJobs(locals.cfContext);

  if (wantsJson) return Response.json({ jobId, label }, { status: 202 });
  return redirect('/manage/jobs', 303);
};
