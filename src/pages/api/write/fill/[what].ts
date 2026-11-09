import type { APIRoute } from 'astro';
import { fillSongLinks } from '../../../../lib/genius';
import { fillPopularity } from '../../../../lib/popularity';
import { fillAlbumSoundFromDeezer } from '../../../../lib/sources/deezer';
import { fillAlbumsMoreFromMusicBrainz } from '../../../../lib/sources/musicbrainz-more';

/**
 * One round of a fill the nightly run does a little at a time, for
 * catching up the whole library at once: answers with what it did and how
 * many are left, so it can be called until none are.
 */
const FILLS: Record<string, () => Promise<{ left: number }>> = {
  // Samples and interpolations, for tracks matched on Genius before links were kept.
  links: () => fillSongLinks({ budgetMs: 25_000, limit: 120 }),
  // Tempo, loudness and explicit, album by album.
  sound: () => fillAlbumSoundFromDeezer({ budgetMs: 25_000, limit: 60 }),
  // Everyone's listens on ListenBrainz.
  popularity: () => fillPopularity({ budgetMs: 25_000, batches: 40 }),
  // Track genres and kinds, labels, lists and awards: two MusicBrainz requests an album.
  musicbrainz: () => fillAlbumsMoreFromMusicBrainz({ budgetMs: 25_000, limit: 30 }),
};

export const POST: APIRoute = async ({ params }) => {
  const fill = FILLS[params.what ?? ''];
  if (!fill) return new Response('Unknown fill.', { status: 404 });
  return Response.json(await fill());
};
