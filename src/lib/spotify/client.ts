/**
 * Spotify Web API access for one user: OAuth, token refresh, and requests.
 *
 * Development Mode only (ARCHITECTURE.md §6). Used for creating and
 * updating playlists and finding track ids; nothing else. Refresh tokens
 * stop working six months after authorisation, so expiry is surfaced as
 * ReauthorizationRequired with a way back, never as a silent failure.
 */

import { env } from 'cloudflare:workers';

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';

/** Playlists and their covers; and, for Now playing, reading and steering playback (src/lib/spotify/player.ts). */
export const SCOPES = [
  'playlist-modify-private',
  'playlist-modify-public',
  'ugc-image-upload',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
];

/**
 * The market availability is judged in. Named outright: "from_token" makes
 * Spotify read the account's country, which needs the user-read-private
 * scope, and without it search fails with 403 "Insufficient client scope"
 * (found on the first real push, November 2026).
 */
export const MARKET = 'IE';

/** Development Mode refresh tokens expire six months after authorisation. */
export const AUTHORIZATION_LIFETIME_DAYS = 182;

export class SpotifyNotConfigured extends Error {
  constructor() {
    super('Spotify is not configured: set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.');
    this.name = 'SpotifyNotConfigured';
  }
}

export class ReauthorizationRequired extends Error {
  constructor() {
    super('Spotify needs reconnecting: the authorisation has expired or been revoked. Reconnect at /manage/spotify.');
    this.name = 'ReauthorizationRequired';
  }
}

export class SpotifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SpotifyError';
  }
}

function credentials(): { id: string; secret: string } {
  const id = env.SPOTIFY_CLIENT_ID;
  const secret = env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) throw new SpotifyNotConfigured();
  return { id, secret };
}

export function isConfigured(): boolean {
  return Boolean(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET);
}

/** Cookie holding the OAuth state between connect and callback. */
export const STATE_COOKIE = 'spotify_oauth_state';
export const OAUTH_PATH = '/api/write/spotify';

/** The redirect URI for this origin. Register http://127.0.0.1 (no port) and the production one. */
export function redirectUriFor(url: URL): string {
  return `${url.origin}${OAUTH_PATH}/callback`;
}

export function authorizeUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: credentials().id,
    scope: SCOPES.join(' '),
    redirect_uri: redirectUri,
    state,
  });
  return `${ACCOUNTS}/authorize?${params}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const { id, secret } = credentials();
  const response = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
  });
  if (response.status === 400) {
    const error = (await response.json().catch(() => ({}))) as { error?: string };
    if (error.error === 'invalid_grant') throw new ReauthorizationRequired();
    throw new SpotifyError(`Spotify token request failed: ${error.error ?? 'bad request'}`, 400);
  }
  if (!response.ok) throw new SpotifyError(`Spotify token request failed: ${response.status}`, response.status);
  return (await response.json()) as TokenResponse;
}

const expiresAt = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

/** Completes the OAuth flow and stores the user's tokens. */
export async function connect(userId: string, code: string, redirectUri: string): Promise<void> {
  const token = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  if (!token.refresh_token) throw new SpotifyError('Spotify did not return a refresh token.', 500);

  await env.DB.prepare(
    `INSERT INTO spotify_token (user_id, refresh_token, access_token, expires_at, authorized_at)
     VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (user_id) DO UPDATE SET
       refresh_token = excluded.refresh_token,
       access_token  = excluded.access_token,
       expires_at    = excluded.expires_at,
       authorized_at = excluded.authorized_at`,
  )
    .bind(userId, token.refresh_token, token.access_token, expiresAt(token.expires_in))
    .run();
}

export interface Connection {
  authorized_at: string;
  expires_on: string;
  days_left: number;
}

export async function connection(userId: string): Promise<Connection | null> {
  const row = await env.DB.prepare('SELECT authorized_at FROM spotify_token WHERE user_id = ?')
    .bind(userId)
    .first<{ authorized_at: string }>();
  if (!row) return null;
  const expires = new Date(new Date(row.authorized_at).getTime() + AUTHORIZATION_LIFETIME_DAYS * 86_400_000);
  return {
    authorized_at: row.authorized_at,
    expires_on: expires.toISOString(),
    days_left: Math.floor((expires.getTime() - Date.now()) / 86_400_000),
  };
}

/** A valid access token, refreshed if it is about to expire. */
async function accessToken(userId: string, force = false): Promise<string> {
  const row = await env.DB.prepare(
    'SELECT refresh_token, access_token, expires_at FROM spotify_token WHERE user_id = ?',
  )
    .bind(userId)
    .first<{ refresh_token: string; access_token: string | null; expires_at: string | null }>();
  if (!row) throw new ReauthorizationRequired();

  const fresh = row.access_token && row.expires_at && new Date(row.expires_at).getTime() - Date.now() > 60_000;
  if (fresh && !force) return row.access_token!;

  const token = await tokenRequest({ grant_type: 'refresh_token', refresh_token: row.refresh_token });
  // Spotify may rotate the refresh token; authorized_at is unchanged, since
  // the six-month clock runs from the original authorisation.
  await env.DB.prepare(
    `UPDATE spotify_token
     SET access_token = ?, expires_at = ?, refresh_token = coalesce(?, refresh_token)
     WHERE user_id = ?`,
  )
    .bind(token.access_token, expiresAt(token.expires_in), token.refresh_token ?? null, userId)
    .run();
  return token.access_token;
}

/** A request body sent as given rather than as JSON: base64 image data. */
class RawBody {
  constructor(
    readonly text: string,
    readonly type: string,
  ) {}
}

/** An authenticated API client for one user. */
export function spotifyFor(userId: string) {
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    attempt = 1,
    refreshed = false,
  ): Promise<T> {
    const token = await accessToken(userId, refreshed);
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body instanceof RawBody ? { 'Content-Type': body.type } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body instanceof RawBody ? body.text : body !== undefined ? JSON.stringify(body) : undefined,
    });

    // An access token can be revoked early; refresh once and retry.
    if (response.status === 401 && !refreshed) return request<T>(method, path, body, attempt, true);

    if (response.status === 429 && attempt <= 3) {
      const wait = Number(response.headers.get('Retry-After') ?? '1');
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 30) * 1000));
      return request<T>(method, path, body, attempt + 1, refreshed);
    }

    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new SpotifyError(
        `Spotify ${method} ${path.split('?')[0]} failed (${response.status})${detail?.error?.message ? `: ${detail.error.message}` : ''}`,
        response.status,
      );
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    // The player's commands can answer 200 with a body that isn't JSON; they still worked.
    try {
      return (text ? JSON.parse(text) : undefined) as T;
    } catch {
      return undefined as T;
    }
  }

  return {
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body: unknown) => request<T>('POST', path, body),
    put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
    /** Spotify takes playlist covers as base64 JPEG in the body, up to 256 KB. */
    putJpeg: (path: string, base64: string) => request<void>('PUT', path, new RawBody(base64, 'image/jpeg')),
  };
}

export type SpotifyClient = ReturnType<typeof spotifyFor>;
