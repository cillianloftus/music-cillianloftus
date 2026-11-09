import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';
import { fillMoreFromMusicBrainz, recordingKinds, trackGenres } from './sources/musicbrainz-more';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
  db.exec(`UPDATE release_group SET mbid = 'mb-rg-a' WHERE id = 'rg-a'`);
  db.exec(`UPDATE release SET mbid = 'mb-r-a' WHERE id = 'r-a'`);
  db.exec(`UPDATE recording SET mbid = 'mb-' || id WHERE id IN ('a1', 'a2', 'a3')`);
});

const performs = (...attributes: string[]) => ({ type: 'performance', 'target-type': 'work', attributes });

const lookups = {
  release: async () => ({
    packaging: 'Jewel Case',
    'label-info': [
      { 'catalog-number': 'XL 123', label: { id: 'mb-xl', name: 'XL Recordings', 'sort-name': 'XL Recordings', type: 'Original Production', 'label-code': 5124 } },
      { 'catalog-number': null, label: { id: 'mb-none', name: '[no label]' } },
    ],
    'release-group': { rating: { value: 4.5, 'votes-count': 12 } },
    media: [
      {
        tracks: [
          {
            recording: {
              id: 'mb-a1',
              genres: [
                { name: 'rock', count: 8 },
                { name: 'jazz rap', count: 4 },
                { name: 'polka', count: 1 },
              ],
              rating: { value: 4, 'votes-count': 3 },
              relations: [performs('cover')],
            },
          },
          { recording: { id: 'mb-a2', relations: [performs('live', 'instrumental')] } },
          { recording: { id: 'mb-not-ours', genres: [{ name: 'rock', count: 2 }] } },
        ],
      },
    ],
  }),
  series: async () => ({
    relations: [
      { type: 'part of', 'target-type': 'series', direction: 'forward', 'attribute-values': { number: '42' }, series: { id: 'mb-rs', name: 'Rolling Stone 500', type: 'Release group series' } },
      { type: 'part of', 'target-type': 'series', direction: 'forward', 'attribute-values': {}, series: { id: 'mb-q', name: 'Qobuz Ideal Discography', type: 'Release group series' } },
    ],
  }),
};

describe('more from MusicBrainz', () => {
  it('keeps a track’s voted genres, not a passing tag among many', () => {
    expect(trackGenres([{ name: 'rock', count: 8 }, { name: 'jazz rap', count: 4 }, { name: 'polka', count: 1 }]).map((g) => g.name)).toEqual(['rock', 'jazz rap']);
    expect(trackGenres([{ name: 'rock', count: 1 }, { name: 'pop', count: 1 }]).map((g) => g.weight)).toEqual([1, 1]);
    expect(trackGenres(undefined)).toEqual([]);
  });

  it('reads cover, live and instrumental from the link to the song', () => {
    expect(recordingKinds({ id: 'x', relations: [performs('cover')] })).toEqual({ cover: 1, live: 0, instrumental: 0 });
    expect(recordingKinds({ id: 'x' })).toBeNull();
  });

  it('fills track genres and kinds, labels with catalogue numbers, ratings, packaging and lists', async () => {
    expect(await fillMoreFromMusicBrainz('rg-a', lookups)).toEqual({ genres: 2, kinds: 2, labels: 1, series: 2, credits: 0 });
    expect(db.prepare(`SELECT g.name, t.weight FROM genre_tag t JOIN genre g ON g.id = t.genre_id WHERE t.entity_id = 'a1' AND t.source = 'musicbrainz' ORDER BY t.weight DESC`).all()).toEqual([
      { name: 'rock', weight: 1 },
      { name: 'jazz rap', weight: 0.5 },
    ]);
    expect(db.prepare(`SELECT is_cover, is_live, is_instrumental, mb_rating, mb_rating_votes FROM recording WHERE id = 'a1'`).get()).toEqual({
      is_cover: 1,
      is_live: 0,
      is_instrumental: 0,
      mb_rating: 4,
      mb_rating_votes: 3,
    });
    expect(db.prepare(`SELECT is_live, is_instrumental FROM recording WHERE id = 'a2'`).get()).toEqual({ is_live: 1, is_instrumental: 1 });
    expect(db.prepare(`SELECT l.name, rl.catalog_number FROM release_label rl JOIN label l ON l.id = rl.label_id WHERE rl.release_id = 'r-a'`).all()).toEqual([
      { name: 'XL Recordings', catalog_number: 'XL 123' },
    ]);
    expect(db.prepare(`SELECT mb_rating FROM release_group WHERE id = 'rg-a'`).get()).toEqual({ mb_rating: 4.5 });
    expect(db.prepare(`SELECT packaging FROM release WHERE id = 'r-a'`).get()).toEqual({ packaging: 'Jewel Case' });
    expect(db.prepare(`SELECT s.name, x.number FROM release_group_series x JOIN series s ON s.id = x.series_id ORDER BY s.name`).all()).toEqual([
      { name: 'Qobuz Ideal Discography', number: null },
      { name: 'Rolling Stone 500', number: '42' },
    ]);
    // Again: nothing doubled.
    await fillMoreFromMusicBrainz('rg-a', lookups);
    expect(db.prepare(`SELECT count(*) AS n FROM release_label`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT count(*) AS n FROM genre_tag WHERE source = 'musicbrainz' AND entity_type = 'recording'`).get()).toEqual({ n: 2 });
  });

  it('makes a track’s credits precise: the instrument in place of “performer”, a plain performer left as one', async () => {
    db.exec(`UPDATE artist SET mbid = 'mb-' || id WHERE id IN ('art-p', 'art-y')`);
    insert(db, 'artist_credit', [
      { id: 'c-sax', entity_type: 'recording', entity_id: 'a2', artist_id: 'art-p', role: 'performer' },
      { id: 'c-plain', entity_type: 'recording', entity_id: 'a2', artist_id: 'art-y', role: 'performer' },
    ]);
    const withCredits = {
      ...lookups,
      release: async () => {
        const release = await lookups.release();
        release.media[0]!.tracks![1]!.recording.relations = [
          performs('live', 'instrumental'),
          { type: 'instrument', 'target-type': 'artist', attributes: ['alto saxophone'], artist: { id: 'mb-art-p' } },
          { type: 'instrument', 'target-type': 'artist', attributes: [], artist: { id: 'mb-art-y' } },
        ] as never;
        return release;
      },
    };
    expect((await fillMoreFromMusicBrainz('rg-a', withCredits)).credits).toBe(1);
    expect(db.prepare(`SELECT label, family FROM credit_role WHERE id = 'alto_saxophone'`).get()).toEqual({ label: 'Alto saxophone', family: 'performance' });
    expect(db.prepare(`SELECT artist_id, role FROM artist_credit WHERE entity_id = 'a2' AND role <> 'primary' ORDER BY artist_id`).all()).toEqual([
      { artist_id: 'art-p', role: 'alto_saxophone' },
      { artist_id: 'art-y', role: 'performer' },
    ]);
  });

  it('leaves a track’s genres set by hand as its only ones', async () => {
    insert(db, 'genre_tag', [{ entity_type: 'recording', entity_id: 'a1', genre_id: 'g-pop', source: 'manual', weight: 1 }]);
    await fillMoreFromMusicBrainz('rg-a', lookups);
    expect(db.prepare(`SELECT genre_id FROM v_recording_genre WHERE recording_id = 'a1'`).all()).toEqual([{ genre_id: 'g-pop' }]);
  });
});
