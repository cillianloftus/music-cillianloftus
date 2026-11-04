import { describe, expect, it } from 'vitest';
import { bufferReader, readTags } from './read';

// Minimal files built byte by byte to each format's spec: just enough
// structure for a tag reader, no audio.

const enc = new TextEncoder();
const concat = (...parts: (Uint8Array | number[])[]) => {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let i = 0;
  for (const a of arrays) {
    out.set(a, i);
    i += a.length;
  }
  return out;
};
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const syncsafe = (n: number) => [(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127];

function vorbisComment(comments: Record<string, string>) {
  const vendor = enc.encode('test');
  const entries = Object.entries(comments).map(([k, v]) => enc.encode(`${k}=${v}`));
  return concat(le32(vendor.length), vendor, le32(entries.length), ...entries.flatMap((e) => [new Uint8Array(le32(e.length)), e]));
}

const MBID = '0f3c4f2b-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const RECORDING = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function flac(comments: Record<string, string>, rate = 44100, samples = 44100 * 200) {
  const info = new Uint8Array(34);
  info[10] = (rate >> 12) & 255;
  info[11] = (rate >> 4) & 255;
  info[12] = ((rate & 15) << 4) | 0x02; // + channels/bps bits, ignored
  info[13] = 0x70 | Math.floor(samples / 2 ** 32);
  info.set(be32(samples >>> 0), 14);
  const comment = vorbisComment(comments);
  return concat(
    enc.encode('fLaC'),
    [0x00, 0, 0, 34], info,
    [0x84, (comment.length >> 16) & 255, (comment.length >> 8) & 255, comment.length & 255], comment,
  );
}

function id3Frame(version: 3 | 4, id: string, body: Uint8Array) {
  return concat(enc.encode(id), version === 4 ? syncsafe(body.length) : be32(body.length), [0, 0], body);
}
const latin = (s: string) => concat([0], enc.encode(s));
const utf16 = (s: string) => {
  const out = [1, 0xff, 0xfe];
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out.push(c & 255, c >> 8);
  }
  return new Uint8Array(out);
};

function id3(version: 3 | 4, frames: Uint8Array[], audio = [0xff, 0xfb, 0x90, 0x00]) {
  const body = concat(...frames, new Uint8Array(16)); // with padding
  return concat(enc.encode('ID3'), [version, 0, 0], syncsafe(body.length), body, audio);
}

function atom(type: string, ...children: (Uint8Array | number[])[]) {
  const body = concat(...children);
  // Atom types are four bytes; "©nam" uses the single byte 0xA9, not UTF-8.
  return concat(be32(body.length + 8), [...type].map((c) => c.charCodeAt(0)), body);
}
const dataAtom = (value: Uint8Array | number[], type = 1) => atom('data', be32(type), [0, 0, 0, 0], value);

describe('readTags', () => {
  it('reads FLAC Vorbis comments and the length from STREAMINFO', async () => {
    const tags = await readTags(
      bufferReader(
        flac({
          TITLE: 'Song One',
          ARTIST: 'Quadeca feat. Kevin Abstract',
          ALBUMARTIST: 'Quadeca',
          ALBUM: 'Scrapyard',
          TRACKNUMBER: '3/12',
          DISCNUMBER: '1',
          DATE: '2024-07-26T00:00:00',
          MUSICBRAINZ_ALBUMID: MBID,
          MUSICBRAINZ_TRACKID: RECORDING.toUpperCase(),
          RELEASETYPE: 'Album',
        }),
      ),
    );
    expect(tags).toMatchObject({
      format: 'flac',
      title: 'Song One',
      artist: 'Quadeca feat. Kevin Abstract',
      albumArtist: 'Quadeca',
      album: 'Scrapyard',
      track: 3,
      disc: 1,
      date: '2024-07-26',
      lengthMs: 200_000,
      mbReleaseId: MBID,
      mbRecordingId: RECORDING,
      releaseType: 'album',
    });
  });

  it('reads ID3v2.3 text, user text and the MusicBrainz UFID', async () => {
    const tags = await readTags(
      bufferReader(
        id3(3, [
          id3Frame(3, 'TIT2', latin('Dreams')),
          id3Frame(3, 'TPE1', latin('Fleetwood Mac')),
          id3Frame(3, 'TALB', latin('Rumours')),
          id3Frame(3, 'TRCK', latin('2/11')),
          id3Frame(3, 'TYER', latin('1977')),
          id3Frame(3, 'TLEN', latin('257000')),
          id3Frame(3, 'TXXX', concat(latin('MusicBrainz Album Id'), [0], enc.encode(MBID))),
          id3Frame(3, 'UFID', concat(enc.encode('http://musicbrainz.org'), [0], enc.encode(RECORDING))),
        ]),
      ),
    );
    expect(tags).toMatchObject({
      format: 'mp3',
      title: 'Dreams',
      artist: 'Fleetwood Mac',
      album: 'Rumours',
      track: 2,
      date: '1977',
      lengthMs: 257_000,
      mbReleaseId: MBID,
      mbRecordingId: RECORDING,
    });
  });

  it('reads ID3v2.4 with synchsafe sizes and UTF-16 text', async () => {
    const tags = await readTags(
      bufferReader(
        id3(4, [
          id3Frame(4, 'TIT2', utf16('Jóga')),
          id3Frame(4, 'TPE1', utf16('Björk')),
          id3Frame(4, 'TPE2', latin('Björk')),
          id3Frame(4, 'TDRC', latin('1997-09-22')),
          id3Frame(4, 'TPOS', latin('1/1')),
        ]),
      ),
    );
    expect(tags).toMatchObject({ title: 'Jóga', artist: 'Björk', date: '1997-09-22', disc: 1 });
  });

  it('reads iTunes atoms from an MP4 whose moov comes after the audio', async () => {
    const ilst = atom(
      'ilst',
      atom('\xa9nam', dataAtom(enc.encode('Holocene'))),
      atom('\xa9ART', dataAtom(enc.encode('Bon Iver'))),
      atom('\xa9alb', dataAtom(enc.encode('Bon Iver, Bon Iver'))),
      atom('trkn', dataAtom([0, 0, 0, 3, 0, 10, 0, 0], 0)),
      atom('\xa9day', dataAtom(enc.encode('2011-06-17T07:00:00Z'))),
      atom('----', atom('mean', [0, 0, 0, 0], enc.encode('com.apple.iTunes')), atom('name', [0, 0, 0, 0], enc.encode('MusicBrainz Album Id')), dataAtom(enc.encode(MBID))),
    );
    const mvhd = atom('mvhd', [0, 0, 0, 0], be32(0), be32(0), be32(1000), be32(337_000), new Uint8Array(80));
    const moov = atom('moov', mvhd, atom('udta', atom('meta', [0, 0, 0, 0], atom('hdlr', new Uint8Array(25)), ilst)));
    const file = concat(atom('ftyp', enc.encode('M4A '), be32(0)), atom('mdat', new Uint8Array(4096)), moov);
    expect(await readTags(bufferReader(file))).toMatchObject({
      format: 'm4a',
      title: 'Holocene',
      artist: 'Bon Iver',
      album: 'Bon Iver, Bon Iver',
      track: 3,
      date: '2011-06-17',
      lengthMs: 337_000,
      mbReleaseId: MBID,
    });
  });

  it('reads Opus tags from the second Ogg page', async () => {
    const page = (packet: Uint8Array) => concat(enc.encode('OggS'), new Uint8Array(22), [Math.ceil(packet.length / 255) || 1], [...Array(Math.ceil(packet.length / 255) || 1)].map((_, i, all) => (i === all.length - 1 ? packet.length % 255 || 255 : 255)), packet);
    const head = page(concat(enc.encode('OpusHead'), new Uint8Array(11)));
    const tagsPage = page(concat(enc.encode('OpusTags'), vorbisComment({ TITLE: 'Night', ARTIST: 'Someone', ALBUM: 'Tape' })));
    expect(await readTags(bufferReader(concat(head, tagsPage)))).toMatchObject({ format: 'opus', title: 'Night', album: 'Tape' });
  });

  it('knows an untagged MP3, and rejects what is not audio', async () => {
    expect(await readTags(bufferReader(new Uint8Array([0xff, 0xfb, 0x90, 0, ...new Uint8Array(20)])))).toMatchObject({ format: 'mp3', title: null });
    expect(await readTags(bufferReader(enc.encode('not an audio file at all')))).toBeNull();
    expect(await readTags(bufferReader(new Uint8Array(3)))).toBeNull();
  });
});
