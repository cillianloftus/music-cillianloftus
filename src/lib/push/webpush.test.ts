import { describe, expect, it } from 'vitest';
import { encryptPayload, fromB64url, toB64url, vapidAuthorization } from './webpush';

const text = new TextEncoder();

/** What a browser does with a push it receives (RFC 8291 §3.4), written apart from the sender. */
async function decryptAsDevice(body: Uint8Array<ArrayBuffer>, device: CryptoKeyPair, auth: Uint8Array<ArrayBuffer>): Promise<string> {
  const salt = body.slice(0, 16);
  const recordSize = new DataView(body.buffer).getUint32(16);
  const idLength = body[20]!;
  const senderPublic = body.slice(21, 21 + idLength);
  const sealed = body.slice(21 + idLength);
  expect(recordSize).toBe(4096);

  const devicePublic = new Uint8Array(await crypto.subtle.exportKey('raw', device.publicKey));
  const sender = await crypto.subtle.importKey('raw', senderPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: sender }, device.privateKey, 256));
  const derive = async (s: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, n: number) =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: s, info },
        await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']),
        n * 8,
      ),
    );
  const info = new Uint8Array([...text.encode('WebPush: info\0'), ...devicePublic, ...senderPublic]);
  const ikm = await derive(auth, shared, info, 32);
  const cek = await derive(salt, ikm, text.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await derive(salt, ikm, text.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, sealed));
  // The last record ends with 0x02, then any padding zeros.
  let end = plain.length - 1;
  while (plain[end] === 0) end--;
  expect(plain[end]).toBe(2);
  return new TextDecoder().decode(plain.slice(0, end));
}

describe('web push', () => {
  it('encrypts a message only the device can read', async () => {
    const device = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const target = { p256dh: toB64url(new Uint8Array(await crypto.subtle.exportKey('raw', device.publicKey))), auth: toB64url(auth) };
    const message = JSON.stringify({ title: 'Rate Pink + White', body: 'Frank Ocean, not rated yet' });

    const body = await encryptPayload(text.encode(message), target);
    expect(await decryptAsDevice(body, device, auth)).toBe(message);

    // A fresh key and salt each time: the same message never looks the same twice.
    const again = await encryptPayload(text.encode(message), target);
    expect(toB64url(again)).not.toBe(toB64url(body));
  });

  it('matches the worked example in RFC 8291 (appendix A) byte for byte', async () => {
    const asPublic = fromB64url('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
    const jwk = { kty: 'EC', crv: 'P-256', x: toB64url(asPublic.slice(1, 33)), y: toB64url(asPublic.slice(33)), d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', ext: true };
    const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const publicKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    const body = await encryptPayload(
      text.encode('When I grow up, I want to be a watermelon'),
      { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
      { salt: fromB64url('DGv6ra1nlYgDCS1FRnbzlw'), keys: { privateKey, publicKey } },
    );
    expect(toB64url(body)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('signs a VAPID token the push service can check against the public key', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const publicKey = toB64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
    const privateKey = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d!;
    const now = Date.UTC(2026, 10, 11, 12);

    const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', { publicKey, privateKey, subject: 'https://example.com' }, now);
    const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(key).toBe(publicKey);
    const [h, c, s] = token!.split('.') as [string, string, string];
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(c)));
    expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'https://example.com' });
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, fromB64url(s), text.encode(`${h}.${c}`));
    expect(ok).toBe(true);
  });
});
