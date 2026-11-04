/**
 * Links that open Spotify, which opens the app on a phone. With a known
 * Spotify id, the album or track itself; otherwise a search, which still
 * lands one tap away.
 */
export function spotifyLink(kind: 'album' | 'track', spotifyId: string | null, query: string): string {
  return spotifyId
    ? `https://open.spotify.com/${kind}/${spotifyId}`
    : `https://open.spotify.com/search/${encodeURIComponent(query)}`;
}
