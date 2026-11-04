/**
 * Builds an ImportPlan from MusicBrainz.
 */

import { parsePartialDate } from '../dates';
import { browseReleases, getRelease, getReleaseGroup } from '../musicbrainz/client';
import type { MbTarget } from '../musicbrainz/input';
import type {
  MbArtist,
  MbArtistCredit,
  MbMedium,
  MbRelation,
  MbRelease,
  MbReleaseGroup,
  MbReleaseSummary,
} from '../musicbrainz/types';
import type {
  CreditEntity,
  CreditRole,
  ImportPlan,
  PlanArtist,
  PlanCredit,
  PlanGenre,
  PlanRecording,
  PlanReleaseGroup,
  PlanTrack,
  PlanWork,
  ReleaseGroupType,
} from './plan';

/** Fetch whatever the target names and turn it into a plan. */
export async function planFromMusicBrainz(target: MbTarget): Promise<ImportPlan> {
  if (target.entity === 'release') {
    const release = await getRelease(target.mbid);
    const group = await getReleaseGroup(release['release-group'].id);
    return buildPlan(release, group);
  }

  const group = await getReleaseGroup(target.mbid);
  const chosen = chooseRelease(await browseReleases(group.id));
  if (!chosen) throw new Error(`Release group ${group.title} has no releases on MusicBrainz yet.`);
  const release = await getRelease(chosen.id);
  return buildPlan(release, group);
}

/**
 * Sort key for release dates. A partial date sorts after any full date in
 * the period it covers ("1977" after "1977-02-04"), so the precisely dated
 * original wins over a vaguely dated pressing. Undated releases sort last.
 */
function rankDate(date: string | undefined): string {
  if (!date) return '9999-99-99';
  return (date + '-99-99').slice(0, 10);
}

export function trackCount(release: MbReleaseSummary): number {
  return (release.media ?? []).reduce((sum, medium) => sum + (medium['track-count'] ?? 0), 0);
}

/**
 * Which edition to import when given only the album: the standard original.
 * Other editions can be imported later and attach to the same group.
 *
 *   1. official releases first
 *   2. earliest date
 *   3. fewest tracks: several editions often share the release day, and
 *      deluxe, CD-bonus and vinyl editions add tracks far more often than
 *      they remove them
 *   4. no disambiguation ("24-Bit", "Extended Cut" mark a variant)
 *   5. MBID, so the choice is stable however MusicBrainz orders its list
 */
export function chooseRelease(releases: MbReleaseSummary[]): MbReleaseSummary | null {
  const ranked = [...releases].sort(
    (a, b) =>
      Number(b.status === 'Official') - Number(a.status === 'Official') ||
      rankDate(a.date).localeCompare(rankDate(b.date)) ||
      (trackCount(a) || Infinity) - (trackCount(b) || Infinity) ||
      Number(Boolean(a.disambiguation)) - Number(Boolean(b.disambiguation)) ||
      a.id.localeCompare(b.id),
  );
  return ranked[0] ?? null;
}

export function mapReleaseGroupType(primary: string | null, secondary: string[]): ReleaseGroupType {
  // Secondary types describe what kind of album it is, so they win.
  if (secondary.includes('Live')) return 'live';
  if (secondary.includes('Soundtrack')) return 'soundtrack';
  if (secondary.includes('Mixtape/Street')) return 'mixtape';
  if (secondary.includes('Compilation')) return 'compilation';
  if (primary === 'EP') return 'ep';
  if (primary === 'Single') return 'single';
  return 'album';
}

/** MusicBrainz relationship types, mapped onto the credit roles we keep. */
const RELATION_ROLES: Record<string, CreditRole> = {
  producer: 'producer',
  'co-producer': 'producer',
  'executive producer': 'producer',
  engineer: 'engineer',
  audio: 'engineer',
  recording: 'engineer',
  sound: 'engineer',
  mastering: 'engineer',
  mix: 'mixer',
  'mix-DJ': 'mixer',
  remixer: 'remixer',
  vocal: 'performer',
  instrument: 'performer',
  performer: 'performer',
  'performing orchestra': 'performer',
  conductor: 'performer',
  composer: 'writer',
  lyricist: 'writer',
  writer: 'writer',
  librettist: 'writer',
};

const FEATURING = /\b(feat\.?|ft\.?|featuring)\s*$/i;

class PlanBuilder {
  private artists = new Map<string, PlanArtist>();
  private works = new Map<string, PlanWork>();
  private credits = new Map<string, PlanCredit>();
  private positions = new Map<string, number>();

  artist(artist: MbArtist): string {
    if (!this.artists.has(artist.id)) {
      this.artists.set(artist.id, {
        key: artist.id,
        mbid: artist.id,
        name: artist.name,
        sort_name: artist['sort-name'] || artist.name,
        disambiguation: artist.disambiguation || null,
      });
    }
    return artist.id;
  }

  work(id: string, title: string): string {
    if (!this.works.has(id)) this.works.set(id, { key: id, mbid: id, title });
    return id;
  }

  credit(
    entity: CreditEntity,
    entityMbid: string,
    artist: MbArtist,
    role: CreditRole,
    extra: { credited_as?: string | null; join_phrase?: string } = {},
  ): void {
    const key = `${entity}:${entityMbid}:${artist.id}:${role}`;
    if (this.credits.has(key)) return;

    const slot = `${entity}:${entityMbid}:${role}`;
    const position = (this.positions.get(slot) ?? 0) + 1;
    this.positions.set(slot, position);

    this.credits.set(key, {
      entity,
      entity_key: entityMbid,
      artist_key: this.artist(artist),
      role,
      position,
      credited_as: extra.credited_as && extra.credited_as !== artist.name ? extra.credited_as : null,
      join_phrase: extra.join_phrase ?? '',
    });
  }

  /** The displayed artist line: primary until a "feat." join, then featured. */
  artistCredit(entity: CreditEntity, entityMbid: string, credits: MbArtistCredit[] = []): void {
    let role: CreditRole = 'primary';
    for (const credit of credits) {
      this.credit(entity, entityMbid, credit.artist, role, {
        credited_as: credit.name,
        join_phrase: credit.joinphrase,
      });
      if (FEATURING.test(credit.joinphrase)) role = 'featured';
    }
  }

  relations(entity: CreditEntity, entityMbid: string, relations: MbRelation[] = []): void {
    for (const relation of relations) {
      if (relation['target-type'] !== 'artist' || !relation.artist) continue;
      const role = RELATION_ROLES[relation.type];
      if (role) this.credit(entity, entityMbid, relation.artist, role);
    }
  }

  result() {
    return {
      artists: [...this.artists.values()],
      works: [...this.works.values()],
      credits: [...this.credits.values()],
    };
  }
}

function formatSummary(media: MbMedium[]): string | null {
  const counts = new Map<string, number>();
  for (const medium of media) {
    const format = medium.format ?? 'Unknown';
    counts.set(format, (counts.get(format) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts]
    .map(([format, count]) => (count > 1 ? `${count}×${format}` : format))
    .join(' + ');
}

function genresFrom(group: MbReleaseGroup): PlanGenre[] {
  const genres = (group.genres ?? []).filter((genre) => genre.count > 0);
  const top = Math.max(0, ...genres.map((genre) => genre.count));
  return genres
    .sort((a, b) => b.count - a.count)
    .map((genre) => ({ name: genre.name, weight: genre.count / top }));
}

export function buildPlan(release: MbRelease, group: MbReleaseGroup): ImportPlan {
  const builder = new PlanBuilder();
  const today = new Date().toISOString().slice(0, 10);

  const groupDate = parsePartialDate(group['first-release-date']);
  const releaseGroup: PlanReleaseGroup = {
    key: group.id,
    mbid: group.id,
    title: group.title,
    type: mapReleaseGroupType(group['primary-type'], group['secondary-types'] ?? []),
    // A first release date after today means the album is only announced.
    status: groupDate.date && groupDate.date > today ? 'announced' : 'released',
    first_release_date: groupDate.date,
    date_precision: groupDate.precision,
  };
  builder.artistCredit('release_group', group.id, group['artist-credit'] ?? release['artist-credit']);

  const releaseDate = parsePartialDate(release.date);
  builder.artistCredit('release', release.id, release['artist-credit']);
  builder.relations('release', release.id, release.relations);

  const recordings = new Map<string, PlanRecording>();
  const tracks: PlanTrack[] = [];

  for (const medium of release.media) {
    for (const track of medium.tracks ?? []) {
      const recording = track.recording;

      const performance = recording.relations?.find(
        (relation) => relation['target-type'] === 'work' && relation.type === 'performance' && relation.work,
      );
      const work = performance?.work;
      if (work) {
        builder.work(work.id, work.title);
        // Writers belong to the work, but credits attach to recordings.
        builder.relations('recording', recording.id, work.relations);
      }

      if (!recordings.has(recording.id)) {
        const date = parsePartialDate(recording['first-release-date']);
        recordings.set(recording.id, {
          key: recording.id,
          mbid: recording.id,
          title: recording.title,
          length_ms: recording.length ?? track.length ?? null,
          first_release_date: date.date,
          date_precision: date.precision,
          isrc: recording.isrcs?.[0] ?? null,
          work_key: work?.id ?? null,
        });
        builder.artistCredit('recording', recording.id, recording['artist-credit']);
        builder.relations('recording', recording.id, recording.relations);
      }

      tracks.push({
        recording_key: recording.id,
        disc: medium.position,
        position: track.position,
        title_on_release: track.title !== recording.title ? track.title : null,
      });
    }
  }

  const label = release['label-info']?.find((info) => info.label)?.label?.name ?? null;

  return {
    source: 'musicbrainz',
    ...builder.result(),
    recordings: [...recordings.values()],
    releaseGroup,
    release: {
      key: release.id,
      mbid: release.id,
      title: release.title,
      date: releaseDate.date,
      date_precision: releaseDate.precision,
      country: release.country && release.country.length === 2 ? release.country : null,
      label,
      format: formatSummary(release.media),
    },
    tracks,
    releaseGroupGenres: genresFrom(group),
  };
}
