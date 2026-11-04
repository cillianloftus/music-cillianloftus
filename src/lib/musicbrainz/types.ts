/**
 * The subset of MusicBrainz JSON responses the importer reads.
 * https://musicbrainz.org/doc/MusicBrainz_API
 */

export interface MbArtist {
  id: string;
  name: string;
  'sort-name': string;
  disambiguation?: string;
}

export interface MbArtistCredit {
  name: string;
  joinphrase: string;
  artist: MbArtist;
}

export interface MbWork {
  id: string;
  title: string;
  relations?: MbRelation[];
}

export interface MbRelation {
  type: string;
  'target-type': string;
  direction?: 'forward' | 'backward';
  artist?: MbArtist;
  work?: MbWork;
}

export interface MbRecording {
  id: string;
  title: string;
  length: number | null;
  'first-release-date'?: string;
  isrcs?: string[];
  'artist-credit'?: MbArtistCredit[];
  relations?: MbRelation[];
}

export interface MbTrack {
  id: string;
  position: number;
  title: string;
  length: number | null;
  recording: MbRecording;
}

export interface MbMedium {
  position: number;
  format: string | null;
  tracks?: MbTrack[];
}

export interface MbGenre {
  name: string;
  count: number;
}

export interface MbReleaseGroup {
  id: string;
  title: string;
  'primary-type': string | null;
  'secondary-types': string[];
  'first-release-date': string;
  'artist-credit'?: MbArtistCredit[];
  genres?: MbGenre[];
}

export interface MbReleaseSummary {
  id: string;
  title: string;
  status: string | null;
  date?: string;
  country?: string | null;
  disambiguation?: string;
  /** Present when browsed with inc=media. */
  media?: { format: string | null; 'track-count': number }[];
}

export interface MbRelease {
  id: string;
  title: string;
  status: string | null;
  date?: string;
  country?: string | null;
  'artist-credit': MbArtistCredit[];
  'release-group': MbReleaseGroup;
  'label-info'?: { label: { name: string } | null }[];
  media: MbMedium[];
  relations?: MbRelation[];
}
