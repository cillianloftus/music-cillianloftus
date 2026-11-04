/**
 * Reads the files out of a zip, for Spotify's data export, which arrives as
 * one. Stored and deflated entries only (all a zip from Spotify uses),
 * inflated with the platform's DecompressionStream. No imports: bundled
 * into the browser.
 */

export interface ZipEntry {
  name: string;
  read(): Promise<Uint8Array>;
}

const u16 = (b: DataView, i: number) => b.getUint16(i, true);
const u32 = (b: DataView, i: number) => b.getUint32(i, true);

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The entries of a zip, via its central directory. Throws if it is not a zip it can read. */
export function zipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record is in the last 64 KB + 22 bytes.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (u32(view, i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('Not a zip file.');
  const count = u16(view, end + 10);
  let at = u32(view, end + 16);
  const names = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (u32(view, at) !== 0x02014b50) throw new Error('Damaged zip directory.');
    const method = u16(view, at + 10);
    const compressed = u32(view, at + 20);
    const nameLength = u16(view, at + 28);
    const extraLength = u16(view, at + 30);
    const commentLength = u16(view, at + 32);
    const local = u32(view, at + 42);
    const name = names.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    entries.push({
      name,
      async read() {
        if (u32(view, local) !== 0x04034b50) throw new Error(`Damaged entry ${name}.`);
        const start = local + 30 + u16(view, local + 26) + u16(view, local + 28);
        const data = bytes.subarray(start, start + compressed);
        if (method === 0) return data;
        if (method === 8) return inflate(data);
        throw new Error(`${name} uses a compression method this cannot read.`);
      },
    });
  }
  return entries;
}
