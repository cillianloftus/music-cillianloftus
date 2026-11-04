/**
 * Reads the tags of an audio file: ID3v2 (MP3), Vorbis comments (FLAC, Ogg
 * Vorbis, Opus) and iTunes atoms (MP4/M4A). Runs in the browser, so only
 * the tags ever leave the machine (ARCHITECTURE.md §3: no audio is
 * uploaded). Reads through a range reader and touches only the bytes it
 * needs, so a folder of large FLACs is quick.
 *
 * No imports from the rest of the app: this module is bundled into the page.
 */

export type AudioFormat = 'mp3' | 'flac' | 'ogg' | 'opus' | 'm4a';

export interface Tags {
  format: AudioFormat;
  title: string | null;
  artist: string | null;
  albumArtist: string | null;
  album: string | null;
  track: number | null;
  disc: number | null;
  date: string | null;
  lengthMs: number | null;
  /** MusicBrainz release, from Picard or similar. Lets the full import take over. */
  mbReleaseId: string | null;
  /** MusicBrainz recording. */
  mbRecordingId: string | null;
  releaseType: string | null;
}

/** Bytes [offset, offset + length) of the file; shorter at the end of the file. */
export type RangeReader = (offset: number, length: number) => Promise<Uint8Array>;

export function bufferReader(bytes: Uint8Array): RangeReader {
  return async (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length));
}

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');
const ascii = (b: Uint8Array, start: number, length: number) => latin1.decode(b.subarray(start, start + length));
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
const u32le = (b: Uint8Array, i: number) => b[i]! + (b[i + 1]! << 8) + (b[i + 2]! << 16) + ((b[i + 3]! << 24) >>> 0);
const synchsafe = (b: Uint8Array, i: number) => (b[i]! << 21) | (b[i + 1]! << 14) | (b[i + 2]! << 7) | b[i + 3]!;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (value: string | undefined | null) => (value && UUID.test(value.trim()) ? value.trim().toLowerCase() : null);

/** "3/12" → 3. */
const leadingNumber = (value: string | undefined | null) => {
  const n = value ? parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Keeps a leading YYYY, YYYY-MM or YYYY-MM-DD. */
const partialDate = (value: string | undefined | null) => value?.trim().match(/^\d{4}(-\d{2}(-\d{2})?)?/)?.[0] ?? null;

const clean = (value: string | undefined | null) => {
  const v = value?.replace(/\0+$/, '').trim();
  return v ? v : null;
};

function emptyTags(format: AudioFormat): Tags {
  return {
    format,
    title: null,
    artist: null,
    albumArtist: null,
    album: null,
    track: null,
    disc: null,
    date: null,
    lengthMs: null,
    mbReleaseId: null,
    mbRecordingId: null,
    releaseType: null,
  };
}

/** Vorbis comment keys (FLAC, Ogg) and their equivalents, upper-cased. */
function fromComments(format: AudioFormat, comments: Map<string, string>): Tags {
  const get = (...keys: string[]) => keys.map((k) => comments.get(k)).find((v) => v !== undefined);
  return {
    ...emptyTags(format),
    title: clean(get('TITLE')),
    artist: clean(get('ARTIST')),
    albumArtist: clean(get('ALBUMARTIST', 'ALBUM ARTIST')),
    album: clean(get('ALBUM')),
    track: leadingNumber(get('TRACKNUMBER')),
    disc: leadingNumber(get('DISCNUMBER')),
    date: partialDate(get('DATE', 'ORIGINALDATE', 'YEAR')),
    mbReleaseId: uuid(get('MUSICBRAINZ_ALBUMID')),
    mbRecordingId: uuid(get('MUSICBRAINZ_TRACKID')),
    releaseType: clean(get('RELEASETYPE', 'MUSICBRAINZ_ALBUMTYPE'))?.toLowerCase() ?? null,
  };
}

/** A Vorbis comment block: vendor, then KEY=value pairs, little-endian lengths. */
function parseVorbisComment(b: Uint8Array, start: number): Map<string, string> {
  const comments = new Map<string, string>();
  let i = start;
  if (i + 8 > b.length) return comments;
  i += 4 + u32le(b, i); // vendor
  if (i + 4 > b.length) return comments;
  const count = u32le(b, i);
  i += 4;
  for (let n = 0; n < count && i + 4 <= b.length; n++) {
    const length = u32le(b, i);
    i += 4;
    if (i + length > b.length) break;
    const entry = utf8.decode(b.subarray(i, i + length));
    i += length;
    const eq = entry.indexOf('=');
    if (eq > 0) {
      const key = entry.slice(0, eq).toUpperCase();
      // The first value wins; repeated keys (several artists) are rare in practice.
      if (!comments.has(key)) comments.set(key, entry.slice(eq + 1));
    }
  }
  return comments;
}

async function readFlac(read: RangeReader): Promise<Tags> {
  const comments = new Map<string, string>();
  let lengthMs: number | null = null;
  let offset = 4;
  for (let guard = 0; guard < 64; guard++) {
    const header = await read(offset, 4);
    if (header.length < 4) break;
    const last = (header[0]! & 0x80) !== 0;
    const type = header[0]! & 0x7f;
    const length = (header[1]! << 16) | (header[2]! << 8) | header[3]!;
    if (type === 0) {
      const info = await read(offset + 4, 18);
      // Sample rate: 20 bits from byte 10. Total samples: 36 bits from byte 13 (low nibble).
      const rate = (info[10]! << 12) | (info[11]! << 4) | (info[12]! >> 4);
      const samples = (info[13]! & 0x0f) * 2 ** 32 + u32be(info, 14);
      if (rate > 0 && samples > 0) lengthMs = Math.round((samples / rate) * 1000);
    } else if (type === 4) {
      for (const [k, v] of parseVorbisComment(await read(offset + 4, length), 0)) comments.set(k, v);
    }
    offset += 4 + length;
    if (last) break;
  }
  return { ...fromComments('flac', comments), lengthMs };
}

async function readOgg(read: RangeReader): Promise<Tags> {
  // The comment header sits in the first few pages. Strip page headers so a
  // comment spanning pages reads as one stream.
  const head = await read(0, 256 * 1024);
  const parts: Uint8Array[] = [];
  let i = 0;
  while (i + 27 <= head.length && ascii(head, i, 4) === 'OggS') {
    const segments = head[i + 26]!;
    let size = 0;
    for (let s = 0; s < segments; s++) size += head[i + 27 + s]!;
    const start = i + 27 + segments;
    parts.push(head.subarray(start, Math.min(head.length, start + size)));
    i = start + size;
  }
  const stream = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    stream.set(p, at);
    at += p.length;
  }
  const text = latin1.decode(stream);
  const opus = text.indexOf('OpusTags');
  if (opus >= 0) return fromComments('opus', parseVorbisComment(stream, opus + 8));
  const vorbis = text.indexOf('\x03vorbis');
  if (vorbis >= 0) return fromComments('ogg', parseVorbisComment(stream, vorbis + 7));
  return emptyTags('ogg');
}

function id3Text(frame: Uint8Array): string {
  const encoding = frame[0];
  const body = frame.subarray(1);
  switch (encoding) {
    case 1: // UTF-16 with BOM
      return new TextDecoder(body[0] === 0xfe ? 'utf-16be' : 'utf-16le').decode(body.subarray(2)).replace(/\0.*$/s, '');
    case 2:
      return new TextDecoder('utf-16be').decode(body).replace(/\0.*$/s, '');
    case 3:
      return utf8.decode(body).replace(/\0.*$/s, '');
    default:
      return latin1.decode(body).replace(/\0.*$/s, '');
  }
}

/** TXXX: encoding, description, NUL, value. Returns [description, value]. */
function id3UserText(frame: Uint8Array): [string, string] {
  const encoding = frame[0]!;
  const body = frame.subarray(1);
  const wide = encoding === 1 || encoding === 2;
  let split = -1;
  for (let i = 0; i + (wide ? 1 : 0) < body.length; i += wide ? 2 : 1) {
    if (body[i] === 0 && (!wide || body[i + 1] === 0)) {
      split = i;
      break;
    }
  }
  if (split < 0) return ['', ''];
  const decode = (bytes: Uint8Array) => id3Text(new Uint8Array([encoding, ...bytes]));
  const descriptionBytes = body.subarray(0, split);
  let value = body.subarray(split + (wide ? 2 : 1));
  // A UTF-16 value carries its own BOM.
  if (encoding === 1 && !(value[0] === 0xff || value[0] === 0xfe)) value = new Uint8Array([0xff, 0xfe, ...value]);
  const description = encoding === 1 && !(descriptionBytes[0] === 0xff || descriptionBytes[0] === 0xfe)
    ? decode(new Uint8Array([0xff, 0xfe, ...descriptionBytes]))
    : decode(descriptionBytes);
  return [description, decode(value)];
}

async function readId3(read: RangeReader): Promise<Tags> {
  const header = await read(0, 10);
  const version = header[3]!;
  const size = synchsafe(header, 6);
  const tags = emptyTags('mp3');
  if (version < 3 || version > 4) return tags; // ID3v2.2 is too old to be worth the code.
  const body = await read(10, size);
  const frames = new Map<string, string>();
  const user = new Map<string, string>();
  let i = 0;
  // An extended header, if flagged, comes first.
  if (header[5]! & 0x40) i += version === 4 ? synchsafe(body, 0) : u32be(body, 0) + 4;
  while (i + 10 <= body.length) {
    const id = ascii(body, i, 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break; // padding
    const length = version === 4 ? synchsafe(body, i + 4) : u32be(body, i + 4);
    const frame = body.subarray(i + 10, i + 10 + length);
    i += 10 + length;
    if (id === 'TXXX') {
      const [description, value] = id3UserText(frame);
      user.set(description.toUpperCase(), value);
    } else if (id === 'UFID') {
      const nul = frame.indexOf(0);
      if (nul > 0 && ascii(frame, 0, nul) === 'http://musicbrainz.org') frames.set('UFID', ascii(frame, nul + 1, frame.length - nul - 1));
    } else if (id[0] === 'T' && !frames.has(id)) {
      frames.set(id, id3Text(frame));
    }
  }
  const tlen = leadingNumber(frames.get('TLEN'));
  return {
    ...tags,
    title: clean(frames.get('TIT2')),
    artist: clean(frames.get('TPE1')),
    albumArtist: clean(frames.get('TPE2')),
    album: clean(frames.get('TALB')),
    track: leadingNumber(frames.get('TRCK')),
    disc: leadingNumber(frames.get('TPOS')),
    date: partialDate(frames.get('TDRC') ?? frames.get('TDOR') ?? frames.get('TYER')),
    lengthMs: tlen,
    mbReleaseId: uuid(user.get('MUSICBRAINZ ALBUM ID')),
    mbRecordingId: uuid(frames.get('UFID')),
    releaseType: clean(user.get('MUSICBRAINZ ALBUM TYPE'))?.toLowerCase() ?? null,
  };
}

/** Finds a child atom by type within [start, end) of b. */
function findAtom(b: Uint8Array, start: number, end: number, type: string): { start: number; end: number } | null {
  let i = start;
  while (i + 8 <= end) {
    let size = u32be(b, i);
    const name = ascii(b, i + 4, 4);
    let header = 8;
    if (size === 1) {
      size = u32be(b, i + 8) * 2 ** 32 + u32be(b, i + 12);
      header = 16;
    } else if (size === 0) {
      size = end - i;
    }
    if (size < header) return null;
    if (name === type) return { start: i + header, end: Math.min(end, i + size) };
    i += size;
  }
  return null;
}

async function readMp4(read: RangeReader): Promise<Tags> {
  // moov may be at the start or the end; walk top-level atom headers to it.
  let offset = 0;
  let moov: Uint8Array | null = null;
  for (let guard = 0; guard < 64; guard++) {
    const header = await read(offset, 16);
    if (header.length < 8) break;
    let size = u32be(header, 0);
    if (size === 1) size = u32be(header, 8) * 2 ** 32 + u32be(header, 12);
    if (size < 8) break;
    if (ascii(header, 4, 4) === 'moov') {
      moov = await read(offset, Math.min(size, 16 * 1024 * 1024));
      break;
    }
    offset += size;
  }
  const tags = emptyTags('m4a');
  if (!moov) return tags;

  const root = findAtom(moov, 0, moov.length, 'moov');
  if (!root) return tags;
  let lengthMs: number | null = null;
  const mvhd = findAtom(moov, root.start, root.end, 'mvhd');
  if (mvhd) {
    const v1 = moov[mvhd.start] === 1;
    const scale = u32be(moov, mvhd.start + (v1 ? 20 : 12));
    const duration = v1 ? u32be(moov, mvhd.start + 24) * 2 ** 32 + u32be(moov, mvhd.start + 28) : u32be(moov, mvhd.start + 16);
    if (scale > 0) lengthMs = Math.round((duration / scale) * 1000);
  }
  const udta = findAtom(moov, root.start, root.end, 'udta');
  const meta = udta && findAtom(moov, udta.start, udta.end, 'meta');
  const ilst = meta && findAtom(moov, meta.start + 4, meta.end, 'ilst'); // meta is a full atom
  if (!ilst) return { ...tags, lengthMs };

  const items = new Map<string, Uint8Array>();
  const free = new Map<string, string>();
  let i = ilst.start;
  while (i + 8 <= ilst.end) {
    const size = u32be(moov, i);
    if (size < 8) break;
    const name = ascii(moov, i + 4, 4);
    const end = Math.min(ilst.end, i + size);
    const data = findAtom(moov, i + 8, end, 'data');
    if (name === '----') {
      const nameAtom = findAtom(moov, i + 8, end, 'name');
      if (nameAtom && data) free.set(utf8.decode(moov.subarray(nameAtom.start + 4, nameAtom.end)).toUpperCase(), utf8.decode(moov.subarray(data.start + 8, data.end)));
    } else if (data) {
      items.set(name, moov.subarray(data.start + 8, data.end));
    }
    i += size;
  }
  const text = (key: string) => {
    const v = items.get(key);
    return v ? clean(utf8.decode(v)) : null;
  };
  const pairNumber = (key: string) => {
    const v = items.get(key);
    return v && v.length >= 4 ? ((v[2]! << 8) | v[3]!) || null : null;
  };
  return {
    ...tags,
    title: text('\xa9nam'),
    artist: text('\xa9ART'),
    albumArtist: text('aART'),
    album: text('\xa9alb'),
    track: pairNumber('trkn'),
    disc: pairNumber('disk'),
    date: partialDate(text('\xa9day')),
    lengthMs,
    mbReleaseId: uuid(free.get('MUSICBRAINZ ALBUM ID')),
    mbRecordingId: uuid(free.get('MUSICBRAINZ TRACK ID')),
    releaseType: clean(free.get('MUSICBRAINZ ALBUM TYPE'))?.toLowerCase() ?? null,
  };
}

/** Tags for one file, or null when it is not audio this reader understands. */
export async function readTags(read: RangeReader): Promise<Tags | null> {
  const magic = await read(0, 12);
  if (magic.length < 12) return null;
  if (ascii(magic, 0, 3) === 'ID3') return readId3(read);
  if (ascii(magic, 0, 4) === 'fLaC') return readFlac(read);
  if (ascii(magic, 0, 4) === 'OggS') return readOgg(read);
  if (ascii(magic, 4, 4) === 'ftyp') return readMp4(read);
  // An MP3 without ID3v2 tags: a frame sync. Nothing to read but the format.
  if (magic[0] === 0xff && (magic[1]! & 0xe0) === 0xe0) return emptyTags('mp3');
  return null;
}
