import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';
import { ageOf, applyEnrichment, artistAbout, readArtist } from './artists';
import { buildManualPlan } from './import/manual';
import { writePlan } from './import/write';
import type { MbArtistDetails } from './musicbrainz/client';
import { search } from './search';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

const quadeca: MbArtistDetails = {
  id: '3a4024dc-cc62-4d9b-8bed-c22426136a52',
  name: 'Xavier',
  type: 'Person',
  'life-span': { begin: '2000-11-14', end: null },
  area: { name: 'United States' },
  'begin-area': { name: 'Los Angeles' },
  aliases: [
    { name: 'Benjamin Fernando Barajas Lasky', type: 'Legal name' },
    { name: 'Benjamin Lasky', type: 'Search hint' },
    { name: 'xavier', type: null },
  ],
  relations: [
    { type: 'wikidata', 'target-type': 'url', url: { resource: 'https://www.wikidata.org/wiki/Q65060813' } },
    { type: 'streaming', 'target-type': 'url', url: { resource: 'https://open.spotify.com/artist/0ZjvTFC1oJpCQmPEP2E1zN' } },
  ],
};

describe('readArtist', () => {
  it('reads kind, birth, birthplace, aliases and ids', () => {
    expect(readArtist(quadeca)).toMatchObject({
      kind: 'person',
      begin: { date: '2000-11-14', precision: 'day' },
      end: { date: null, precision: 'unknown' },
      area: 'Los Angeles',
      wikidataId: 'Q65060813',
      spotifyId: '0ZjvTFC1oJpCQmPEP2E1zN',
      // The alias that is only the name in another case is dropped.
      aliases: [
        { name: 'Benjamin Fernando Barajas Lasky', kind: 'legal' },
        { name: 'Benjamin Lasky', kind: 'search' },
      ],
    });
  });

  it('calls a group of two a duo', () => {
    const member = (id: string) => ({ type: 'member of band', 'target-type': 'artist', direction: 'backward' as const, artist: { id, name: id } });
    expect(readArtist({ id: 'g', name: 'Pair', type: 'Group', relations: [member('a'), member('b')] }).kind).toBe('duo');
    expect(readArtist({ id: 'g', name: 'Trio', type: 'Group', relations: [member('a'), member('b'), member('c')] }).kind).toBe('group');
  });
});

describe('applyEnrichment', () => {
  it('fills empty fields and never one set by hand', async () => {
    db.exec(`UPDATE artist SET area = 'Dublin' WHERE id = 'art-x'`);
    insert(db, 'field_override', [{ entity_type: 'artist', entity_id: 'art-x', field: 'area', value_json: '"Dublin"', user_id: 'u-owner' }]);
    await applyEnrichment('art-x', readArtist(quadeca));
    expect(db.prepare(`SELECT kind, begin_date, begin_precision, area, wikidata_id FROM artist WHERE id = 'art-x'`).get()).toEqual({
      kind: 'person',
      begin_date: '2000-11-14',
      begin_precision: 'day',
      area: 'Dublin',
      wikidata_id: 'Q65060813',
    });
    const about = await artistAbout('art-x');
    expect(about.aliases.map((a) => a.name)).toEqual(['Benjamin Fernando Barajas Lasky', 'Benjamin Lasky']);
  });

  it('links members to their group when both are here', async () => {
    db.prepare(`UPDATE artist SET mbid = ? WHERE id = 'art-y'`).run('22222222-2222-4222-8222-222222222222');
    await applyEnrichment('art-x', { ...readArtist(quadeca), kind: 'group', members: ['22222222-2222-4222-8222-222222222222'] });
    expect((await artistAbout('art-x')).members).toEqual([{ id: 'art-y', name: 'Yolanda' }]);
    expect((await artistAbout('art-y')).memberOf).toEqual([{ id: 'art-x', name: 'Xavier' }]);
  });
});

describe('aliases', () => {
  beforeEach(async () => applyEnrichment('art-x', readArtist(quadeca)));

  it('are searchable', async () => {
    expect((await search('lasky', 'u-owner')).artists.map((a) => a.id)).toEqual(['art-x']);
    // Name and alias both match "xav…"? Only the name does; the artist appears once either way.
    expect((await search('xav', 'u-owner')).artists.map((a) => a.id)).toEqual(['art-x']);
  });

  it('survive the artist being renamed', async () => {
    db.exec(`UPDATE artist SET name = 'Quadeca' WHERE id = 'art-x'`);
    expect((await search('lasky', 'u-owner')).artists.map((a) => a.id)).toEqual(['art-x']);
  });

  it('let a credit under another name find the same artist', async () => {
    const plan = buildManualPlan({ artist: 'Benjamin Lasky', title: 'Demo Tape', type: 'mixtape', date: '', genres: '', tracklist: 'One' });
    const result = await writePlan(plan);
    const credit = db.prepare(`SELECT artist_id FROM artist_credit WHERE entity_type = 'release_group' AND entity_id = ?`).get(result.releaseGroupId);
    expect(credit).toEqual({ artist_id: 'art-x' });
  });
});

describe('ageOf', () => {
  it('counts whole years to the birthday, for people with a known day', () => {
    const p = { kind: 'person' as const, begin_date: '2000-11-14', begin_precision: 'day' as const, end_date: null };
    expect(ageOf(p, new Date('2026-11-04T12:00:00Z'))).toBe(25);
    expect(ageOf(p, new Date('2026-11-14T12:00:00Z'))).toBe(26);
    expect(ageOf({ ...p, begin_precision: 'year', begin_date: '2000' })).toBeNull();
    expect(ageOf({ ...p, kind: 'group' })).toBeNull();
  });
});

describe('artistGenres', () => {
  it('reads genres off their own tracks, leaving out the rare ones', async () => {
    const { artistGenres } = await import('./artists');
    const { migratedDb, seedLibrary } = await import('../test/db');
    const { d1 } = await import('../test/d1');
    const db = migratedDb();
    seedLibrary(db);
    (env as { DB: D1Database }).DB = d1(db);
    // Xavier: a1–a4 inherit indie pop from Album A, b1 bedroom pop from B, b2 its own rock.
    expect((await artistGenres('art-x')).map((g) => [g.name, g.tracks])).toEqual([
      ['indie pop', 4],
      ['bedroom pop', 1],
      ['rock', 1],
    ]);
  });
});
