import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../../test/d1';
import { insert, migratedDb } from '../../test/db';
import { groupAlbums, VARIOUS_ARTISTS, type FileRecord } from '../tags/albums';
import { splitArtist } from '../tags/albums';
import { attachFiles, filesPayload, importFiles, releaseGroupType } from './files';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  (env as { DB: D1Database }).DB = d1(db);
});

const MBID = '0f3c4f2b-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

function file(path: string, tags: Partial<FileRecord> = {}): FileRecord {
  return {
    path,
    size: 8_000_000,
    checksum: 'a'.repeat(64),
    format: 'flac',
    title: null,
    artist: null,
    albumArtist: null,
    album: null,
    track: null,
    disc: null,
    date: null,
    lengthMs: 200_000,
    mbReleaseId: null,
    mbRecordingId: null,
    releaseType: null,
    ...tags,
  };
}

const tape = [
  file('Tape/02 Second.flac', { title: 'Second', artist: 'Mx Demo', album: 'Tape', track: 2, date: '2019' }),
  file('Tape/01 First.flac', { title: 'First', artist: 'Mx Demo feat. Pal & Bud', album: 'Tape', track: 1, date: '2019' }),
];

describe('grouping', () => {
  it('groups by album and orders by disc and track', () => {
    const [album] = groupAlbums(tape);
    expect(album).toMatchObject({ artist: 'Mx Demo', title: 'Tape', date: '2019', notes: [] });
    expect(album!.tracks.map((t) => [t.position, t.title])).toEqual([
      [1, 'First'],
      [2, 'Second'],
    ]);
    expect(album!.tracks[0]!.bitrate).toBe(320); // 8 MB over 200 s
  });

  it('falls back to the folder and file names, and file order', () => {
    const [album] = groupAlbums([file('Untagged Demos/03 - Gamma.mp3'), file('Untagged Demos/01 - Alpha.mp3')]);
    expect(album).toMatchObject({ title: 'Untagged Demos', artist: 'Unknown artist' });
    expect(album!.tracks.map((t) => [t.position, t.title])).toEqual([
      [1, 'Alpha'],
      [2, 'Gamma'],
    ]);
    expect(album!.notes.join(' ')).toMatch(/folder.*file order.*file name/s);
  });

  it('reads "Artist - Album" folders and "NN - Artist - Title" files when untagged', () => {
    const [album] = groupAlbums([
      file('Jon Bellion - LIVE FROM FOREST HILLS/02 Jon Bellion - BLU - Live.flac'),
      file('Jon Bellion - LIVE FROM FOREST HILLS/01 Jon Bellion - 80S FILMS - Live.flac'),
    ]);
    expect(album).toMatchObject({ artist: 'Jon Bellion', title: 'LIVE FROM FOREST HILLS' });
    expect(album!.tracks.map((t) => [t.position, t.title, t.artist])).toEqual([
      [1, '80S FILMS - Live', 'Jon Bellion'],
      [2, 'BLU - Live', 'Jon Bellion'],
    ]);
    // The record sent on keeps what the tags said, which was nothing.
    expect(album!.tracks[0]!.file.title).toBeNull();
  });

  it('files a mixed album without an album artist under Various Artists', () => {
    const [album] = groupAlbums([
      file('Mix/1.flac', { album: 'Mix', artist: 'A', track: 1 }),
      file('Mix/2.flac', { album: 'Mix', artist: 'B', track: 2 }),
    ]);
    expect(album!.artist).toBe(VARIOUS_ARTISTS);
    expect(album!.tracks.map((t) => t.artist)).toEqual(['A', 'B']);
  });

  it('keeps one Picard-tagged release together across folders', () => {
    const albums = groupAlbums([
      file('CD1/1.flac', { album: 'Big', mbReleaseId: MBID, disc: 1, track: 1 }),
      file('CD2/1.flac', { album: 'Big', mbReleaseId: MBID, disc: 2, track: 1 }),
    ]);
    expect(albums).toHaveLength(1);
    expect(albums[0]!.mbReleaseId).toBe(MBID);
  });
});

describe('helpers', () => {
  it('splits featured artists out of an artist tag', () => {
    expect(splitArtist('Mx Demo feat. Pal & Bud')).toEqual({ primary: 'Mx Demo', featured: ['Pal', 'Bud'] });
    expect(splitArtist('Simon & Garfunkel')).toEqual({ primary: 'Simon & Garfunkel', featured: [] });
  });

  it('maps release-type tags', () => {
    expect(releaseGroupType('album; live')).toBe('live');
    expect(releaseGroupType('ep')).toBe('ep');
    expect(releaseGroupType(null)).toBe('album');
  });

  it('validates the payload strictly', () => {
    expect(filesPayload.safeParse({ files: tape }).success).toBe(true);
    expect(filesPayload.safeParse({ files: [{ ...tape[0], audio: 'AAAA' }] }).success).toBe(false);
    expect(filesPayload.safeParse({ files: [] }).success).toBe(false);
  });
});

describe('albums already in the library', () => {
  // Tonight's two: "Welcome To Forever" beside "Young Sinatra: Welcome to
  // Forever" by one of two artists called Logic, and a folder whose artist
  // tag was "Logic_Inglorious_Basterd".
  beforeEach(() => {
    insert(db, 'artist', [
      { id: 'logic', name: 'Logic', sort_name: 'Logic', source: 'spotify' },
      { id: 'logic-dj', name: 'Logic', sort_name: 'Logic', source: 'musicbrainz' },
    ]);
    insert(db, 'release_group', [
      { id: 'wtf', title: 'Young Sinatra: Welcome to Forever', type: 'mixtape', source: 'musicbrainz', mbid: '11111111-1111-1111-1111-111111111111' },
      { id: 'ib', title: 'Inglorious Basterd', type: 'mixtape', source: 'musicbrainz' },
    ]);
    insert(db, 'release', [
      { id: 'wtf-r', release_group_id: 'wtf', title: 'Young Sinatra: Welcome to Forever', source: 'musicbrainz' },
      { id: 'ib-r', release_group_id: 'ib', title: 'Inglorious Basterd', source: 'musicbrainz' },
    ]);
    insert(db, 'recording', [
      { id: 'w1', title: 'Welcome to Forever', source: 'musicbrainz' },
      { id: 'w2', title: 'Ballin', source: 'musicbrainz' },
      { id: 'w3', title: 'Roll', source: 'musicbrainz' },
      { id: 'i1', title: 'Griptape', source: 'musicbrainz' },
      { id: 'i2', title: 'Starfield', source: 'musicbrainz' },
    ]);
    insert(db, 'track', [
      { id: 'tw1', release_id: 'wtf-r', recording_id: 'w1', position: 1 },
      { id: 'tw2', release_id: 'wtf-r', recording_id: 'w2', position: 2 },
      { id: 'tw3', release_id: 'wtf-r', recording_id: 'w3', position: 3 },
      { id: 'ti1', release_id: 'ib-r', recording_id: 'i1', position: 1 },
      { id: 'ti2', release_id: 'ib-r', recording_id: 'i2', position: 2 },
    ]);
    insert(db, 'artist_credit', [
      { id: 'c1', entity_type: 'release_group', entity_id: 'wtf', artist_id: 'logic', role: 'primary' },
      { id: 'c2', entity_type: 'release_group', entity_id: 'ib', artist_id: 'logic', role: 'primary' },
    ]);
  });

  const wtf = ['Welcome to Forever', 'Ballin', 'Roll'].map((title, i) =>
    file(`Logic/WTF/0${i + 1}.flac`, { title, artist: 'Logic', album: 'Young Sinatra: Welcome To Forever', track: i + 1, checksum: String(i).repeat(64) }),
  );
  const ib = [
    file('IB/01.flac', { title: 'Griptape feat. John Lindahl', artist: 'Logic_Inglorious_Basterd', album: 'Inglorious Basterd', track: 1, checksum: 'c'.repeat(64) }),
    file('IB/02.flac', { title: 'Starfield', artist: 'Logic_Inglorious_Basterd', album: 'Inglorious Basterd', track: 2, checksum: 'd'.repeat(64) }),
  ];

  it('are offered to confirm: by artist and title, case aside, or by their songs', async () => {
    const { albumCandidates } = await import('./files');
    const [first] = await albumCandidates({ artist: 'Logic', title: 'Young Sinatra: Welcome To Forever', tracks: ['Welcome to Forever', 'Ballin', 'Roll'] });
    expect(first).toMatchObject({ id: 'wtf', shared: 3, likely: true, tracks: 3, artist: 'Logic' });
    // A shorter title, inside the album's.
    expect((await albumCandidates({ artist: 'Logic', title: 'Welcome to Forever', tracks: ['Ballin', 'Roll'] }))[0]).toMatchObject({ id: 'wtf', likely: true });
    // A wrong artist tag: found by the songs.
    expect((await albumCandidates({ artist: 'Logic_Inglorious_Basterd', title: 'Inglorious Basterd', tracks: ['Griptape feat. John Lindahl', 'Starfield'] }))[0]).toMatchObject({
      id: 'ib',
      shared: 2,
      likely: true,
    });
    // Rip titles carrying guests and producers still match the songs.
    expect(
      (await albumCandidates({ artist: 'Somebody', title: 'Rip', tracks: ['Ballin (ft. Castro) (Prod by Arthur McArthur)', 'Roll (Prod. by 6ix)'] }))[0],
    ).toMatchObject({ id: 'wtf', shared: 2 });
    // Nothing like it: nothing offered.
    expect(await albumCandidates({ artist: 'Someone Else', title: 'Fresh', tracks: ['New One', 'New Two'] })).toEqual([]);
  });

  it('take the files when confirmed, and nothing new is made', async () => {
    const [album] = groupAlbums(ib);
    const [outcome] = await importFiles({ root: '', files: ib, choices: { [album!.key]: 'ib' } });
    expect(outcome).toMatchObject({ status: 'matched', href: '/album/ib' });
    expect(db.prepare(`SELECT path, recording_id FROM file ORDER BY path`).all()).toEqual([
      { path: 'IB/01.flac', recording_id: 'i1' },
      { path: 'IB/02.flac', recording_id: 'i2' },
    ]);
    expect(db.prepare(`SELECT count(*) AS n FROM release_group`).get()).toEqual({ n: 2 });
    expect(db.prepare(`SELECT count(*) AS n FROM artist`).get()).toEqual({ n: 2 });
  });

  it('join the album of the same artist and title even unasked, and are added only when told it is new', async () => {
    const [unasked] = await importFiles({ root: '', files: wtf });
    expect(unasked).toMatchObject({ status: 'matched', href: '/album/wtf' });
    expect(db.prepare(`SELECT count(*) AS n FROM release_group`).get()).toEqual({ n: 2 });

    const other = wtf.map((f) => ({ ...f, path: f.path.replace('WTF', 'WTF copy') }));
    const [album] = groupAlbums(other);
    const [told] = await importFiles({ root: '', files: other, choices: { [album!.key]: 'new' } });
    expect(told!.status).toBe('added');
    expect(db.prepare(`SELECT count(*) AS n FROM release_group`).get()).toEqual({ n: 3 });
  });
});

describe('importing', () => {
  it('writes the album, credits and a file row per track', async () => {
    const [outcome] = await importFiles({ root: 'D:\\Music\\', files: tape });
    expect(outcome).toMatchObject({ status: 'added', title: 'Tape', tracks: 2 });

    const files = db
      .prepare(
        `SELECT f.path, f.format, f.bitrate, r.title, r.source FROM file f JOIN recording r ON r.id = f.recording_id ORDER BY f.path`,
      )
      .all();
    expect(files).toEqual([
      { path: 'D:\\Music/Tape/01 First.flac', format: 'flac', bitrate: 320, title: 'First', source: 'files' },
      { path: 'D:\\Music/Tape/02 Second.flac', format: 'flac', bitrate: 320, title: 'Second', source: 'files' },
    ]);
    const featured = db
      .prepare(`SELECT a.name FROM artist_credit c JOIN artist a ON a.id = c.artist_id WHERE c.role = 'featured' ORDER BY c.position`)
      .all();
    expect(featured).toEqual([{ name: 'Pal' }, { name: 'Bud' }]);
  });

  it('skips a folder already catalogued, so a second run adds nothing', async () => {
    await importFiles({ root: '', files: tape });
    const [again] = await importFiles({ root: '', files: tape });
    expect(again!.status).toBe('skipped');
    expect(db.prepare(`SELECT count(*) AS n FROM release_group`).get()).toEqual({ n: 1 });
  });

  it('queues a Picard-tagged album for the MusicBrainz import, carrying its files', async () => {
    const [outcome] = await importFiles({ root: '', files: tape.map((f) => ({ ...f, mbReleaseId: MBID })) });
    expect(outcome!.status).toBe('queued');
    const job = db.prepare(`SELECT kind, payload_json FROM job`).get() as { kind: string; payload_json: string };
    const payload = JSON.parse(job.payload_json);
    expect(payload.target).toEqual({ entity: 'release', mbid: MBID });
    expect(payload.files.map((f: { path: string }) => f.path)).toEqual(['Tape/01 First.flac', 'Tape/02 Second.flac']);
    expect(db.prepare(`SELECT count(*) AS n FROM release_group`).get()).toEqual({ n: 0 });
  });
});

describe('attachFiles', () => {
  it('matches by recording MBID first, then by position, and skips what matches nothing', async () => {
    insert(db, 'release_group', [{ id: 'rg', title: 'R', type: 'album', source: 'musicbrainz' }]);
    insert(db, 'release', [{ id: 'rel', release_group_id: 'rg', title: 'R', source: 'musicbrainz' }]);
    insert(db, 'recording', [
      { id: 'rec-1', title: 'One', source: 'musicbrainz', mbid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
      { id: 'rec-2', title: 'Two', source: 'musicbrainz' },
    ]);
    insert(db, 'track', [
      { id: 't1', release_id: 'rel', recording_id: 'rec-1', position: 1 },
      { id: 't2', release_id: 'rel', recording_id: 'rec-2', position: 2 },
    ]);
    const base = { format: 'flac', bitrate: null, checksum: null, disc: 1 };
    const added = await attachFiles('rel', [
      { ...base, path: 'x/one.flac', position: 9, mbRecordingId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
      { ...base, path: 'x/two.flac', position: 2, mbRecordingId: null },
      { ...base, path: 'x/ghost.flac', position: 7, mbRecordingId: null },
    ]);
    expect(added).toBe(2);
    expect(db.prepare(`SELECT path, recording_id FROM file ORDER BY path`).all()).toEqual([
      { path: 'x/one.flac', recording_id: 'rec-1' },
      { path: 'x/two.flac', recording_id: 'rec-2' },
    ]);
  });
});
