/**
 * An import plan: everything one release contributes to the catalogue,
 * keyed by external id and not yet tied to local rows. Builders (one per
 * source) produce a plan; `writePlan` resolves it against the database.
 * Keeping the two apart means each source only has to describe what it
 * found, and the rules about matching and filling nulls live in one place.
 */

import type { DatePrecision } from '../dates';

export type Source = 'musicbrainz' | 'spotify' | 'discogs' | 'files' | 'manual';

export type ReleaseGroupType =
  | 'album'
  | 'ep'
  | 'single'
  | 'compilation'
  | 'mixtape'
  | 'soundtrack'
  | 'live';

/**
 * A credit_role id (migration 0018). Roles are data: the built-in ones are
 * seeded, and more can be added from the app, so this is not a closed list.
 */
export type CreditRole = string;

export type CreditEntity = 'release_group' | 'release' | 'recording';

/*
 * Every entity has a `key`, unique within the plan, that other entries use
 * to refer to it. Builders with external ids use the MBID as the key;
 * manual entry makes keys up. `mbid` is null for anything not from
 * MusicBrainz, and then the entity cannot be matched by id.
 */

export interface PlanArtist {
  key: string;
  mbid: string | null;
  /** Spotify's id, when the source is Spotify. Matched like an MBID. */
  spotify_id?: string | null;
  name: string;
  sort_name: string;
  disambiguation: string | null;
}

export interface PlanWork {
  key: string;
  mbid: string | null;
  title: string;
}

export interface PlanRecording {
  key: string;
  mbid: string | null;
  title: string;
  length_ms: number | null;
  first_release_date: string | null;
  date_precision: DatePrecision;
  isrc: string | null;
  work_key: string | null;
  spotify_id?: string | null;
}

export interface PlanReleaseGroup {
  key: string;
  mbid: string | null;
  title: string;
  type: ReleaseGroupType;
  status: 'announced' | 'released' | 'cancelled';
  first_release_date: string | null;
  date_precision: DatePrecision;
  spotify_id?: string | null;
}

export interface PlanRelease {
  key: string;
  mbid: string | null;
  title: string;
  date: string | null;
  date_precision: DatePrecision;
  country: string | null;
  label: string | null;
  format: string | null;
  spotify_id?: string | null;
  /** UPC/EAN, digits only. */
  barcode?: string | null;
}

export interface PlanTrack {
  recording_key: string;
  disc: number;
  position: number;
  title_on_release: string | null;
}

export interface PlanCredit {
  entity: CreditEntity;
  /** Key of the release group, release or recording credited. */
  entity_key: string;
  artist_key: string;
  role: CreditRole;
  position: number;
  credited_as: string | null;
  join_phrase: string;
}

export interface PlanGenre {
  name: string;
  /** 0 < weight <= 1, relative to the most-voted genre. */
  weight: number;
}

export interface ImportPlan {
  source: Source;
  artists: PlanArtist[];
  works: PlanWork[];
  recordings: PlanRecording[];
  releaseGroup: PlanReleaseGroup;
  release: PlanRelease;
  tracks: PlanTrack[];
  credits: PlanCredit[];
  releaseGroupGenres: PlanGenre[];
}
