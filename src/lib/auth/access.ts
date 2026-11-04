/**
 * Cloudflare Access JWT verification.
 *
 * Access sits in front of /edit and /api/write, but the Worker is also
 * reachable on its workers.dev URL, where no Access policy applies. So the
 * Worker never trusts a request because it arrived: it verifies the signed
 * assertion Access attaches, against the team's published keys.
 *
 * https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 */

interface AccessConfig {
  /** e.g. "cillian.cloudflareaccess.com" */
  teamDomain: string;
  /** The Application Audience (AUD) tag of the Access application. */
  audience: string;
}

export interface AccessIdentity {
  email: string;
}

interface JwtHeader {
  alg: string;
  kid: string;
}

interface JwtPayload {
  aud: string | string[];
  email?: string;
  exp: number;
  nbf?: number;
  iss: string;
}

interface Jwks {
  keys: (JsonWebKey & { kid: string })[];
}

const KEY_TTL_MS = 60 * 60 * 1000;
let keyCache: { teamDomain: string; fetchedAt: number; keys: Map<string, CryptoKey> } | null = null;

async function signingKeys(teamDomain: string, forceRefresh = false): Promise<Map<string, CryptoKey>> {
  const fresh =
    keyCache &&
    keyCache.teamDomain === teamDomain &&
    Date.now() - keyCache.fetchedAt < KEY_TTL_MS;
  if (fresh && !forceRefresh) return keyCache!.keys;

  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Access certs request failed: ${response.status}`);
  const jwks = (await response.json()) as Jwks;

  const keys = new Map<string, CryptoKey>();
  for (const jwk of jwks.keys) {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    keys.set(jwk.kid, key);
  }
  keyCache = { teamDomain, fetchedAt: Date.now(), keys };
  return keys;
}

function base64UrlDecode(segment: string): Uint8Array<ArrayBuffer> {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson<T>(segment: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment))) as T;
}

/** Returns the verified identity, or null for any invalid or absent token. */
export async function verifyAccessJwt(
  token: string,
  config: AccessConfig,
): Promise<AccessIdentity | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  let header: JwtHeader;
  let payload: JwtPayload;
  try {
    header = decodeJson<JwtHeader>(headerPart);
    payload = decodeJson<JwtPayload>(payloadPart);
  } catch {
    return null;
  }
  if (header.alg !== 'RS256') return null;

  let key = (await signingKeys(config.teamDomain)).get(header.kid);
  // Keys rotate; an unknown kid is worth one refetch before rejecting.
  if (!key) key = (await signingKeys(config.teamDomain, true)).get(header.kid);
  if (!key) return null;

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlDecode(signaturePart),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) return null;

  const now = Math.floor(Date.now() / 1000);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(config.audience)) return null;
  if (payload.iss !== `https://${config.teamDomain}`) return null;
  if (payload.exp <= now) return null;
  if (payload.nbf !== undefined && payload.nbf > now) return null;
  if (!payload.email) return null;

  return { email: payload.email };
}
