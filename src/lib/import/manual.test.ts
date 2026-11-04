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
