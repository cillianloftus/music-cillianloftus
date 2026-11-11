/**
 * Web Push, sent from the Worker with nothing but Web Crypto: the message
 * is encrypted for the one device (RFC 8291, aes128gcm) and the request
 * signed with this site's VAPID key (RFC 8292), so the push service
 * (Google's, Mozilla's, Apple's) can neither read it nor take it from
 * anyone else.
 */

const text = new TextEncoder();

export function toB64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(value: string): Uint8Array<ArrayBuffer> {
  const s = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The site's VAPID key pair: the public key raw (65 bytes), the private as its JWK "d", both base64url. */
export interface Vapid {
  publicKey: string;
  privateKey: string;
  /** Who runs the sender, for the push service: a mailto: or https: URL. */
  subject: string;
}

/** One device, as the browser's PushSubscription gives it. */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

async function signingKey(vapid: Vapid): Promise<CryptoKey> {
  const pub = fromB64url(vapid.publicKey);
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: toB64url(pub.slice(1, 33)), y: toB64url(pub.slice(33, 65)), d: vapid.privateKey, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

/** The Authorization header for one push service: a JWT good for twelve hours. */
export async function vapidAuthorization(endpoint: string, vapid: Vapid, now = Date.now()): Promise<string> {
  const part = (o: object) => toB64url(text.encode(JSON.stringify(o)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: vapid.subject,
  })}`;
  // Web Crypto signs ECDSA as raw r||s, which is what JWS wants.
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(vapid), text.encode(unsigned));
  return `vapid t=${unsigned}.${toB64url(new Uint8Array(signature))}, k=${vapid.publicKey}`;
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bytes: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/**
 * The body of one push (RFC 8291): a header (salt, record size, this
 * message's own public key) and the payload, sealed with a key only the
 * device can work out. One record, so the payload must stay under 4 kB.
 */
export async function encryptPayload(
  payload: Uint8Array,
  target: Pick<PushTarget, 'p256dh' | 'auth'>,
  fixed: { salt?: Uint8Array<ArrayBuffer>; keys?: CryptoKeyPair } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = fromB64url(target.p256dh);
  const keys = fixed.keys ?? ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  const device = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: device }, keys.privateKey, 256));

  const ikm = await hkdf(fromB64url(target.auth), shared, concat(text.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = fixed.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, text.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, text.encode('Content-Encoding: nonce\0'), 12);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 0x02 marks the last (here the only) record.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(payload, new Uint8Array([2]))));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, sealed);
}

export interface SendOptions {
  /** How long the push service may hold it for a device that is offline, in seconds. */
  ttl?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  /** A newer message with the same topic replaces one not yet delivered. */
  topic?: string;
}

/** Sends one message; returns the push service's status (201 sent, 404/410 device gone). */
export async function sendPush(target: PushTarget, message: unknown, vapid: Vapid, options: SendOptions = {}): Promise<number> {
  const body = await encryptPayload(text.encode(JSON.stringify(message)), target);
  const response = await fetch(target.endpoint, {
    method: 'POST',
    headers: {
      authorization: await vapidAuthorization(target.endpoint, vapid),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(options.ttl ?? 3600),
      urgency: options.urgency ?? 'normal',
      ...(options.topic ? { topic: options.topic } : {}),
    },
    body,
  });
  return response.status;
}
