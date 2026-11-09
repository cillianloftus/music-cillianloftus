import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { migratedDb, seedLibrary } from '../test/db';
import { applyEnrichment, artistAbout } from './artists';
import { editEdition, editionEdit, addAlias, addLink, albumEdit, artistEdit, creditWriter, editAlbum, editArtist, EditError, removeLink } from './edits';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

const album = (overrides: Record<string, string> = {}) =>
  albumEdit.parse({ title: 'Album A', type: 'album', status: 'released', date: '2015-03-02', availability: '', preferred_release_id: '', genres: '', ...overrides });

describe('editAlbum', () => {
  it('changes only what changed, and records each change as the owner’s', async () => {
    await editAlbum('u-owner', 'rg-a', album({ title: 'Album A (Corrected)', date: '2015-03', genres: 'Indie Pop, dream pop' }));
    expect(db.prepare(`SELECT title, first_release_date, date_precision FROM release_group WHERE id = 'rg-a'`).get()).toEqual({
      title: 'Album A (Corrected)',
      first_release_date: '2015-03',
      date_precision: 'month',
    });
    expect((db.prepare(`SELECT field FROM field_override WHERE entity_id = 'rg-a' ORDER BY field`).all() as { field: string }[]).map((r) => r.field)).toEqual([
      'first_release_date',
      'title',
    ]);
    const tags = db.prepare(`SELECT g.name FROM genre_tag t JOIN genre g ON g.id = t.genre_id WHERE t.entity_id = 'rg-a' AND t.source = 'manual' ORDER BY g.name`).all();
    expect(tags).toEqual([{ name: 'dream pop' }, { name: 'indie pop' }]);
  });

  it('only accepts one of the album’s own editions as its standard', async () => {
    await expect(editAlbum('u-owner', 'rg-a', album({ preferred_release_id: 'r-b' }))).rejects.toBeInstanceOf(EditError);
    await editAlbum('u-owner', 'rg-a', album({ preferred_release_id: 'r-a-deluxe' }));
    expect(db.prepare(`SELECT release_id FROM v_release_group_canonical WHERE release_group_id = 'rg-a'`).get()).toEqual({ release_id: 'r-a-deluxe' });
  });

  it('rejects a malformed date', () => {
    expect(albumEdit.safeParse({ ...album(), date: 'spring' }).success).toBe(false);
  });
});

describe('creditWriter', () => {
  it('credits only the standard tracks that have no writer', async () => {
    db.exec(`INSERT INTO artist_credit (id, entity_type, entity_id, artist_id, role) VALUES ('w1', 'recording', 'a1', 'art-p', 'writer')`);
    expect(await creditWriter('rg-a', 'xavier')).toBe(2);
    const writers = db.prepare(`SELECT entity_id, artist_id FROM artist_credit WHERE role = 'writer' ORDER BY entity_id`).all();
    expect(writers).toEqual([
      { entity_id: 'a1', artist_id: 'art-p' },
      { entity_id: 'a2', artist_id: 'art-x' },
      { entity_id: 'a3', artist_id: 'art-x' },
    ]);
  });

  it('finds the writer by another name', async () => {
    await addAlias('art-x', 'Xav');
    expect(await creditWriter('rg-b', 'xav')).toBe(2);
  });
});

describe('artists', () => {
  const details = (overrides: Record<string, string> = {}) =>
    artistEdit.parse({ name: 'Xavier', sort_name: 'Xavier', disambiguation: '', kind: 'person', begin: '1990-05-01', end: '', area: 'Cork', ...overrides });

  it('saves details as overrides that enrichment then leaves alone', async () => {
    await editArtist('u-owner', 'art-x', details());
    await applyEnrichment('art-x', {
      kind: 'group',
      begin: { date: '1980', precision: 'year' },
      end: { date: null, precision: 'unknown' },
      area: 'Paris',
      wikidataId: null,
      spotifyId: null,
      aliases: [],
      links: [],
      members: [],
      memberOf: [],
      memberYears: {},
    });
    expect(await artistAbout('art-x')).toMatchObject({ kind: 'person', begin_date: '1990-05-01', begin_precision: 'day', area: 'Cork' });
  });

  it('links a member to a group, and unlinks it', async () => {
    await addLink('art-y', 'member_of', 'Xavier');
    expect((await artistAbout('art-x')).members).toEqual([{ id: 'art-y', name: 'Yolanda', years: null }]);
    await removeLink('art-x', 'art-y', 'member_of');
    expect((await artistAbout('art-x')).members).toEqual([]);
  });

  it('will not link an artist to itself or to an unknown name', async () => {
    await expect(addLink('art-x', 'same_person', 'Xavier')).rejects.toThrow('itself');
    await expect(addLink('art-x', 'same_person', 'Nobody')).rejects.toThrow('no artist');
  });
});

describe('editEdition', () => {
  it('corrects one edition, leaving the album and its other editions alone', async () => {
    await editEdition('u-owner', 'rg-a', editionEdit.parse({ edition: 'r-a-deluxe', edition_title: 'Album A (Deluxe)', edition_date: '2016-04-10', label: 'Label', format: '' }));
    expect(db.prepare(`SELECT date, date_precision, label FROM release WHERE id = 'r-a-deluxe'`).get()).toEqual({ date: '2016-04-10', date_precision: 'day', label: 'Label' });
    expect(db.prepare(`SELECT first_release_date FROM release_group WHERE id = 'rg-a'`).get()).toEqual({ first_release_date: '2015-03-02' });
    expect((db.prepare(`SELECT field FROM field_override WHERE entity_type = 'release' ORDER BY field`).all() as { field: string }[]).map((r) => r.field)).toEqual(['date', 'label']);
  });

  it('refuses an edition from another album', async () => {
    await expect(editEdition('u-owner', 'rg-b', editionEdit.parse({ edition: 'r-a', edition_title: 'x', edition_date: '', label: '', format: '' }))).rejects.toThrow(EditError);
  });
});

describe('undoing edits', () => {
  it('stops counting as edited once a field is set back, and undo restores the original', async () => {
    const { revertEdit } = await import('./revert');
    await editAlbum('u-owner', 'rg-a', album({ title: 'Renamed' }));
    expect(db.prepare(`SELECT field, original_json FROM field_override WHERE entity_id = 'rg-a'`).all()).toEqual([{ field: 'title', original_json: '"Album A"' }]);
    await editAlbum('u-owner', 'rg-a', album({ title: 'Renamed again' }));
    await editAlbum('u-owner', 'rg-a', album({ title: 'Album A' }));
    expect(db.prepare(`SELECT count(*) AS n FROM field_override WHERE entity_id = 'rg-a'`).get()).toEqual({ n: 0 });

    await editAlbum('u-owner', 'rg-a', album({ date: '2015' }));
    await revertEdit('release_group', 'rg-a', 'first_release_date');
    expect(db.prepare(`SELECT first_release_date, date_precision FROM release_group WHERE id = 'rg-a'`).get()).toEqual({
      first_release_date: '2015-03-02',
      date_precision: 'day',
    });
    expect(db.prepare(`SELECT count(*) AS n FROM field_override WHERE entity_id = 'rg-a'`).get()).toEqual({ n: 0 });
  });

  it('treats credits put back as they were as no longer edited, and can undo credit edits', async () => {
    const { addCredit, removeCredit, recordingCredits } = await import('./credits');
    const { revertEdit } = await import('./revert');
    await addCredit('u-owner', 'a2', { role: 'writer', name: 'Yolanda' });
    const added = (await recordingCredits('a2')).find((c) => c.role === 'writer')!;
    await removeCredit('u-owner', 'a2', added.id);
    expect(db.prepare(`SELECT count(*) AS n FROM field_override WHERE entity_id = 'a2'`).get()).toEqual({ n: 0 });

    await addCredit('u-owner', 'a2', { role: 'producer', name: 'Pat Producer' });
    await revertEdit('recording', 'a2', 'credits');
    expect((await recordingCredits('a2')).map((c) => c.role)).toEqual(['primary']);
  });
});
