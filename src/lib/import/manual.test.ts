import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { d1 } from '../../test/d1';
import { insert, migratedDb } from '../../test/db';
import { buildManualPlan, parseTracklist, sortName, validateManual, type ManualInput } from './manual';
import { writePlan } from './write';

describe('parseTracklist', () => {
  it('reads the formats people paste', () => {
    const tracks = parseTracklist(`
      1. Opening (feat. Guest One & Guest Two) 3:41
      02 Second Song - 4:05
      3 - Third [1:02:03]
      A4 "Quoted" (5:00)
      Plain title
      Song ft. Someone
    `);
    expect(tracks).toEqual([
      { disc: 1, position: 1, title: 'Opening', length_ms: 221_000, featured: ['Guest One', 'Guest Two'] },
      { disc: 1, position: 2, title: 'Second Song', length_ms: 245_000, featured: [] },
      { disc: 1, position: 3, title: 'Third', length_ms: 3_723_000, featured: [] },
      { disc: 1, position: 4, title: 'Quoted', length_ms: 300_000, featured: [] },
      { disc: 1, position: 5, title: 'Plain title', length_ms: null, featured: [] },
      { disc: 1, position: 6, title: 'Song', length_ms: null, featured: ['Someone'] },
    ]);
  });

  it('starts a new disc at a disc heading', () => {
    const tracks = parseTracklist('Disc 1\nOne\nTwo\n\nDisc 2\nThree');
    expect(tracks.map((t) => [t.disc, t.position, t.title])).toEqual([
      [1, 1, 'One'],
      [1, 2, 'Two'],
      [2, 1, 'Three'],
    ]);
  });

  it('keeps titles that start with or contain numbers', () => {
    expect(parseTracklist('22 Acacia Avenue\n1979\nRatio: 2:1\n99 Luftballons').map((t) => t.title)).toEqual([
      '22 Acacia Avenue',
      '1979',
      'Ratio: 2:1',
      '99 Luftballons',
    ]);
  });

  it('strips a bare number only when it is the expected position', () => {
    expect(parseTracklist('01 First\n02 Second\n3 Third').map((t) => t.title)).toEqual(['First', 'Second', 'Third']);
  });
});

describe('sortName', () => {
  it('moves leading articles', () => {
    expect(sortName('The National')).toBe('National, The');
    expect(sortName('Quadeca')).toBe('Quadeca');
  });
});

const input: ManualInput = {
  artist: 'Bedroom Act',
  title: 'Tape One',
  type: 'mixtape',
  date: '2019-08',
  genres: 'Bedroom Pop, lo-fi, bedroom pop',
  tracklist: '1. Intro 1:00\n2. Song (feat. Friend) 3:00',
};

describe('validateManual', () => {
  it('needs an artist and title, and a readable date', () => {
    expect(validateManual({ ...input, artist: ' ', date: 'summer' })).toEqual([
      'Give the artist.',
      'Write the date as 2015, 2015-06 or 2015-06-30, or leave it empty.',
    ]);
    expect(validateManual(input)).toEqual([]);
  });
});

describe('manual plans through the writer', () => {
  it('writes the album with credits, featured artists and genres', async () => {
    const db = migratedDb();
    (env as { DB: D1Database }).DB = d1(db);
    const result = await writePlan(buildManualPlan(input));

    expect(db.prepare('SELECT title, type, first_release_date, date_precision, source FROM release_group').get()).toMatchObject({
      title: 'Tape One',
      type: 'mixtape',
      first_release_date: '2019-08',
      date_precision: 'month',
      source: 'manual',
    });
    expect(db.prepare('SELECT count(*) AS n FROM track WHERE release_id = ?').get(result.releaseId)!.n).toBe(2);
    expect(
      db.prepare("SELECT a.name FROM artist_credit c JOIN artist a ON a.id = c.artist_id WHERE c.role = 'featured'").get()!.name,
    ).toBe('Friend');
    expect(db.prepare('SELECT group_concat(name) AS g FROM (SELECT g.name FROM genre_tag t JOIN genre g ON g.id = t.genre_id ORDER BY g.name)').get()!.g).toBe(
      'bedroom pop,lo-fi',
    );
  });

  it('reuses an existing artist of the same name rather than duplicating', async () => {
    const db = migratedDb();
    (env as { DB: D1Database }).DB = d1(db);
    insert(db, 'artist', [{ id: 'existing', name: 'bedroom act', sort_name: 'bedroom act', source: 'musicbrainz' }]);
    await writePlan(buildManualPlan(input));
    expect(db.prepare("SELECT count(*) AS n FROM artist WHERE lower(name) = 'bedroom act'").get()!.n).toBe(1);
    expect(db.prepare("SELECT artist_id FROM artist_credit WHERE entity_type = 'release_group'").get()!.artist_id).toBe('existing');
  });

  it('makes a new artist when the name is ambiguous', async () => {
    const db = migratedDb();
    (env as { DB: D1Database }).DB = d1(db);
    insert(db, 'artist', [
      { id: 'one', name: 'Bedroom Act', sort_name: 'Bedroom Act', disambiguation: 'UK', source: 'musicbrainz' },
      { id: 'two', name: 'Bedroom Act', sort_name: 'Bedroom Act', disambiguation: 'US', source: 'musicbrainz' },
    ]);
    await writePlan(buildManualPlan(input));
    expect(db.prepare("SELECT count(*) AS n FROM artist WHERE name = 'Bedroom Act'").get()!.n).toBe(3);
  });

  it('accepts an announced album with no tracks yet', async () => {
    const db = migratedDb();
    (env as { DB: D1Database }).DB = d1(db);
    await writePlan(buildManualPlan({ ...input, date: '2099', tracklist: '' }));
    expect(db.prepare('SELECT status FROM release_group').get()!.status).toBe('announced');
  });
});

describe('a release made from songs already here', () => {
  it('finds them by the artist and title, and places them on it as they are', async () => {
    const { seedLibrary } = await import('../../test/db');
    const { existingSongs } = await import('./manual');
    const db = migratedDb();
    seedLibrary(db);
    (env as { DB: D1Database }).DB = d1(db);
    // Xavier's a1 ("Song A1") is rated; "A New One" is not here.
    const input: ManualInput = { artist: 'xavier', title: 'An EP', type: 'ep', date: '', genres: '', tracklist: '1. Song A1 (feat. Someone)\n2. A New One' };
    const tracks = parseTracklist(input.tracklist);
    const found = await existingSongs(input.artist, tracks, 'u-owner');
    expect(found['1-1']?.map((s) => s.id)).toEqual(['a1']);
    expect(found['1-1']?.[0]?.score).not.toBeNull();
    expect(found['1-2']).toBeUndefined();

    const before = (db.prepare(`SELECT count(*) n FROM recording`).get() as { n: number }).n;
    const result = await writePlan(buildManualPlan({ ...input, existing: { '1-1': 'a1' } }));
    const placed = db.prepare(`SELECT t.position, t.recording_id FROM track t WHERE t.release_id = ? ORDER BY t.position`).all(result.releaseId) as { position: number; recording_id: string }[];
    expect(placed[0]?.recording_id).toBe('a1');
    expect(placed[1]?.recording_id).not.toBe('a1');
    // Only the new song was created.
    expect((db.prepare(`SELECT count(*) n FROM recording`).get() as { n: number }).n).toBe(before + 1);
  });
});

describe('an artist’s songs for the builder', () => {
  it('lists every one with the release it is on, and a release of them keeps them as they are', async () => {
    const { seedLibrary } = await import('../../test/db');
    const { artistSongs, fittingChoices } = await import('./manual');
    const db = migratedDb();
    seedLibrary(db);
    (env as { DB: D1Database }).DB = d1(db);
    // Titles numbered in roman (Quadeca's "i. finale") must survive the tracklist's own numbering.
    db.prepare(`UPDATE recording SET title = 'i. finale' WHERE id = 'a1'`).run();
    db.prepare(`UPDATE recording SET title = 'ii. à noite' WHERE id = 'a2'`).run();
    const songs = await artistSongs('Xavier');
    expect(songs.map((s) => s.id)).toEqual(expect.arrayContaining(['a1', 'a2']));
    expect(songs.find((s) => s.id === 'a1')?.album).toBeTruthy();
    expect(await artistSongs('nobody at all')).toEqual([]);

    // As the builder sends it: numbered lines, a song picked for each.
    const tracklist = '1. i. finale\n2. ii. à noite';
    const existing = await fittingChoices({ '1-1': 'a1', '1-2': 'a2' }, parseTracklist(tracklist));
    expect(existing).toEqual({ '1-1': 'a1', '1-2': 'a2' });
    const before = (db.prepare(`SELECT count(*) n FROM recording`).get() as { n: number }).n;
    const result = await writePlan(buildManualPlan({ artist: 'Xavier', title: 'i. ii. iii.', type: 'ep', date: '', genres: '', tracklist, existing }));
    const placed = db.prepare(`SELECT recording_id FROM track WHERE release_id = ? ORDER BY position`).all(result.releaseId) as { recording_id: string }[];
    expect(placed.map((p) => p.recording_id)).toEqual(['a1', 'a2']);
    expect((db.prepare(`SELECT count(*) n FROM recording`).get() as { n: number }).n).toBe(before);
  });
});

describe('an album’s cover on Genius', () => {
  it('is found through its songs, when the album they are on there has its title', async () => {
    const { geniusAlbumCover } = await import('../genius');
    const asked: string[] = [];
    const fetcher = (async (url: string) => {
      asked.push(url);
      const path = new URL(url).pathname + new URL(url).search;
      const body = path.startsWith('/search')
        ? decodeURIComponent(path).includes('finale')
          ? { hits: [{ result: { id: 7, title: 'i. finale', primary_artist: { name: 'Quadeca' } } }, { result: { id: 8, title: 'finale', primary_artist: { name: 'Someone Else' } } }] }
          : { hits: [{ result: { id: 9, title: 'Listening Log', primary_artist: { name: 'Toxi' } } }] }
        : { song: { album: { name: 'i.ii.iii', cover_art_url: 'https://images.genius.com/cover.png' } } };
      return new Response(JSON.stringify({ response: body }));
    }) as typeof fetch;
    // The album's own title finds nothing; its first song leads to the album, "i.ii.iii" being "i. ii. iii.".
    expect(await geniusAlbumCover('t', { artist: 'Quadeca', title: 'i. ii. iii.', tracks: ['i. finale', 'ii. à noite'] }, fetcher)).toBe('https://images.genius.com/cover.png');
    expect(asked.some((u) => u.includes('/songs/7'))).toBe(true);
    // Another album's song is not this album's cover.
    expect(await geniusAlbumCover('t', { artist: 'Quadeca', title: 'Something Else', tracks: ['i. finale'] }, fetcher)).toBeNull();
  });
});

describe('a compilation’s cover on Genius', () => {
  it('comes from the album’s own page when its songs are filed under another album', async () => {
    const { geniusAlbumCover, geniusSlug } = await import('../genius');
    expect(geniusSlug('Quadeca’s Melodic Hits')).toBe('Quadeca-s-melodic-hits');
    const fetcher = (async (url: string) => {
      if (url.startsWith('https://genius.com/albums/Quadeca/Quadeca-s-melodic-hits')) {
        return new Response(
          '<html><head><title>Quadeca - Quadeca’s Melodic Hits Lyrics and Tracklist | Genius</title><meta property="og:image" content="https://images.genius.com/melodic.jpg" /></head></html>',
        );
      }
      const path = new URL(url).pathname;
      const body = path.startsWith('/search')
        ? { hits: [{ result: { id: 1, title: 'Shades of Us', primary_artist: { name: 'Quadeca' } } }] }
        : { song: { album: { name: 'From Me To You', cover_art_url: 'https://images.genius.com/fmty.png' } } };
      return new Response(JSON.stringify({ response: body }));
    }) as typeof fetch;
    expect(await geniusAlbumCover('t', { artist: 'Quadeca', title: 'Quadeca’s Melodic Hits', tracks: ['Shades of Us'] }, fetcher)).toBe('https://images.genius.com/melodic.jpg');
  });
});

describe('songs picked for lines', () => {
  it('are kept while their line still has their title, by any artist, and dropped when it changed', async () => {
    const { seedLibrary } = await import('../../test/db');
    const { fittingChoices } = await import('./manual');
    const db = migratedDb();
    seedLibrary(db);
    (env as { DB: D1Database }).DB = d1(db);
    // c1 is Yolanda's "Song A1 (Cover)"; a1 Xavier's "Song A1".
    const tracks = parseTracklist('1. Song A1 (Cover)\n2. Something Else');
    expect(await fittingChoices({ '1-1': 'c1', '1-2': 'a1' }, tracks)).toEqual({ '1-1': 'c1' });
  });
});
