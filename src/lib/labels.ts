/** Record labels (migration 0055): one label and the albums released on it. */

import { env } from 'cloudflare:workers';
import { releaseGroupsByIds, type ReleaseGroupSummary } from './catalogue';

export interface LabelDetail {
  id: string;
  mbid: string | null;
  name: string;
  disambiguation: string | null;
  type: string | null;
  label_code: number | null;
}

export function labelDetail(id: string): Promise<LabelDetail | null> {
  return env.DB.prepare(`SELECT id, mbid, name, disambiguation, type, label_code FROM label WHERE id = ?`).bind(id).first<LabelDetail>();
}

/** Albums with any edition on the label, newest first; not-official ones left out, as elsewhere. */
export async function labelAlbums(labelId: string, viewerId: string | null): Promise<ReleaseGroupSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT x.release_group_id AS id
     FROM release_label rl JOIN release x ON x.id = rl.release_id
     JOIN release_group g ON g.id = x.release_group_id
     WHERE rl.label_id = ? AND NOT (g.official = 0 AND g.keep_unofficial = 0)`,
  )
    .bind(labelId)
    .all<{ id: string }>();
  const albums = await releaseGroupsByIds(
    results.map((r) => r.id),
    viewerId,
  );
  return albums.sort((a, b) => (b.first_release_date ?? '').localeCompare(a.first_release_date ?? ''));
}
