import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { zipEntries } from './zip';

/** A zip built to the spec: local headers, central directory, end record. */
function zip(files: { name: string; data: string; deflate: boolean }[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: number[] = [];
  const central: number[] = [];
  const le16 = (n: number) => [n & 255, (n >> 8) & 255];
  const le32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  for (const f of files) {
    const raw = enc.encode(f.data);
    const body = f.deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
    const name = enc.encode(f.name);
    const method = f.deflate ? 8 : 0;
    const offset = locals.length;
    // CRCs are left zero: this reader does not check them.
    locals.push(...le32(0x04034b50), ...le16(20), ...le16(0), ...le16(method), ...le16(0), ...le16(0), ...le32(0), ...le32(body.length), ...le32(raw.length), ...le16(name.length), ...le16(0), ...name, ...body);
    central.push(...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(0), ...le16(method), ...le16(0), ...le16(0), ...le32(0), ...le32(body.length), ...le32(raw.length), ...le16(name.length), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(offset), ...name);
  }
  const end = [...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(files.length), ...le16(files.length), ...le32(central.length), ...le32(locals.length), ...le16(0)];
  return new Uint8Array([...locals, ...central, ...end]);
}

describe('zipEntries', () => {
  it('lists and reads stored and deflated entries', async () => {
    const history = JSON.stringify([{ ts: '2025-01-01T00:00:00Z', ms_played: 120000 }]);
    const entries = zipEntries(
      zip([
        { name: 'Spotify Extended Streaming History/Streaming_History_Audio_2025.json', data: history, deflate: true },
        { name: 'ReadMeFirst.txt', data: 'hello', deflate: false },
      ]),
    );
    expect(entries.map((e) => e.name)).toEqual(['Spotify Extended Streaming History/Streaming_History_Audio_2025.json', 'ReadMeFirst.txt']);
    expect(new TextDecoder().decode(await entries[0]!.read())).toBe(history);
    expect(new TextDecoder().decode(await entries[1]!.read())).toBe('hello');
  });

  it('refuses what is not a zip', () => {
    expect(() => zipEntries(new TextEncoder().encode('[{"ts": "2025"}]'))).toThrow('Not a zip');
  });
});
