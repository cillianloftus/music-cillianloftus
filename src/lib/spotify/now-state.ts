/**
 * What Now playing knows about the moment, shared by the server and the
 * page scripts. No imports, so browser code can use it without pulling in
 * the Worker's types.
 */
export interface NowState {
  playing: boolean;
  progressMs: number;
  /** When progressMs was true, so the page can count on between polls. */
  at: number;
  shuffle: boolean;
  repeat: 'off' | 'track' | 'context';
  device: { name: string; type: string } | null;
  track: {
    spotifyId: string;
    title: string;
    artists: string[];
    /** Spotify ids of the artists, in the same order. */
    artistIds: string[];
    album: string;
    albumSpotifyId: string;
    art: string | null;
    durationMs: number;
  } | null;
  /** First song in Spotify's queue, when asked for (?next=1): what to show once this one ends. */
  next?: NowState['track'];
}
