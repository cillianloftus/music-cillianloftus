/**
 * What a job is, in words, for the Jobs pages: an import shows its album
 * (title, artist, cover) once it has landed, its name from queueing until
 * then; a push or backup says what it was.
 */

import { env } from 'cloudflare:workers';
import type { JobRow } from './queue';

export interface ShownJob {
  title: string;
  detail: string;
  href: string | null;
  artKey: string | null;
  hasArt: boolean;
}

export async function describeJobs(jobs: JobRow[]): Promise<Map<string, ShownJob>> {
  const payloads = new Map(
    jobs.map((j) => {
      try {
        return [j.id, JSON.parse(j.payload_json) as Record<string, any>];
      } catch {
        return [j.id, null];
      }
    }),
  );
  const albumIds = [...new Set([...payloads.values()].map((p) => p?.result?.releaseGroupId).filter((x): x is string => typeof x === 'string'))];
  const albums = new Map(
    albumIds.length === 0
      ? []
      : (
          await env.DB.prepare(
            `SELECT g.id, g.title, r.art_key,
                    (SELECT a.name FROM artist_credit c JOIN artist a ON a.id = c.artist_id
                     WHERE c.entity_type = 'release_group' AND c.entity_id = g.id AND c.role = 'primary' ORDER BY c.position LIMIT 1) AS artist
             FROM release_group g
             LEFT JOIN v_release_group_canonical v ON v.release_group_id = g.id
             LEFT JOIN release r ON r.id = v.release_id
             WHERE g.id IN (SELECT value FROM json_each(?))`,
          )
            .bind(JSON.stringify(albumIds))
            .all<{ id: string; title: string; art_key: string | null; artist: string | null }>()
        ).results.map((a) => [a.id, a]),
  );

  const shown = new Map<string, ShownJob>();
  for (const job of jobs) {
    const payload = payloads.get(job.id);
    shown.set(job.id, describe(job, payload, albums));
  }
  return shown;
}

function describe(
  job: JobRow,
  payload: Record<string, any> | null | undefined,
  albums: Map<string, { id: string; title: string; art_key: string | null; artist: string | null }>,
): ShownJob {
  if (!payload) return { title: job.kind, detail: '', href: null, artKey: null, hasArt: false };
  if (job.kind === 'spotify_push') {
    const result = payload.result;
    return {
      title: 'Playlist pushed to Spotify',
      detail: result ? `${result.pushed} of ${result.selected} tracks` : 'Spotify push',
      href: `/playlist/${payload.definitionId}`,
      artKey: null,
      hasArt: false,
    };
  }
  if (job.kind === 'backup') return { title: 'Backup', detail: 'Every table, copied', href: '/manage/backups', artKey: null, hasArt: false };
  const album = payload.result?.releaseGroupId ? albums.get(payload.result.releaseGroupId) : null;
  const t = payload.target;
  const source = payload.source === 'spotify' ? `Spotify ${t?.kind ?? 'album'}` : `MusicBrainz ${t?.entity === 'release-group' ? 'album' : 'edition'}`;
  const via = payload.result?.via === 'musicbrainz' ? ', matched on MusicBrainz' : '';
  if (album) {
    return {
      title: album.title,
      detail: [album.artist, `${source}${via}`].filter(Boolean).join(' · '),
      href: `/album/${album.id}`,
      artKey: album.art_key,
      hasArt: true,
    };
  }
  // Not landed yet: its name when it was known at queueing, else where it comes from.
  if (payload.label) return { title: payload.label, detail: source, href: null, artKey: null, hasArt: true };
  const id = String(t?.id ?? t?.mbid ?? '').slice(0, 8);
  return { title: source, detail: id ? `${id}…` : '', href: null, artKey: null, hasArt: true };
}
