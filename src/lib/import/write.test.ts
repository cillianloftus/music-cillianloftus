import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../../test/d1';
import { migratedDb } from '../../test/db';
import type { ImportPlan } from './plan';
import { writePlan } from './write';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  (env as { DB: D1Database }).DB = d1(db);
});

const count = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);

function plan(overrides: Partial<ImportPlan> = {}): ImportPlan {
  return {
    source: 'musicbrainz',
    artists: [{ key: 'm-artist', mbid: 'm-artist', name: 'Artist', sort_name: 'Artist', disambiguation: null }],
    works: [{ key: 'm-work', mbid: 'm-work', title: 'One' }],
    recordings: [
      { key: 'm-rec1', mbid: 'm-rec1', title: 'One', length_ms: 1000, first_release_date: null, date_precision: 'unknown', isrc: null, work_key: 'm-work' },
      { key: 'm-rec2', mbid: 'm-rec2', title: 'Two', length_ms: null, first_release_date: null, date_precision: 'unknown', isrc: null, work_key: null },
    ],
    releaseGroup: { key: 'm-rg', mbid: 'm-rg', title: 'Album', type: 'album', status: 'released', first_release_date: '2020', date_precision: 'year' },
    release: { key: 'm-rel', mbid: 'm-rel', title: 'Album', date: '2020', date_precision: 'year', country: 'IE', label: null, format: 'CD' },
    tracks: [
      { recording_key: 'm-rec1', disc: 1, position: 1, title_on_release: null },
      { recording_key: 'm-rec2', disc: 1, position: 2, title_on_release: null },
    ],
    credits: [
      { entity: 'release_group', entity_key: 'm-rg', artist_key: 'm-artist', role: 'primary', position: 1, credited_as: null, join_phrase: '' },
      { entity: 'recording', entity_key: 'm-rec1', artist_key: 'm-artist', role: 'primary', position: 1, credited_as: null, join_phrase: '' },
    ],
    releaseGroupGenres: [{ name: 'art pop', weight: 1 }],
    ...overrides,
  };
}

describe('writePlan', () => {
  it('writes a whole album', async () => {
    const result = await writePlan(plan());
    expect(result.createdReleaseGroup).toBe(true);
    expect(count('release_group')).toBe(1);
    expect(count('recording')).toBe(2);
    expect(count('track')).toBe(2);
    expect(count('artist_credit')).toBe(2);
    expect(count('genre_tag')).toBe(1);
    expect(db.prepare("SELECT work_id FROM recording WHERE mbid = 'm-rec1'").get()!.work_id).toBeTruthy();
  });

  it('is idempotent', async () => {
    await writePlan(plan());
    const again = await writePlan(plan());
    expect(again.createdReleaseGroup).toBe(false);
    expect(again.createdRelease).toBe(false);
    for (const table of ['artist', 'work', 'recording', 'release_group', 'release', 'track', 'artist_credit', 'genre', 'genre_tag']) {
      expect(count(table), table).toBe(table === 'track' ? 2 : table === 'artist_credit' ? 2 : table === 'recording' ? 2 : 1);
    }
  });

  it('attaches a new edition to the existing album, reusing its recordings', async () => {
    const first = await writePlan(plan());
    const deluxe = plan({
      release: { key: 'm-rel-deluxe', mbid: 'm-rel-deluxe', title: 'Album (Deluxe)', date: '2021', date_precision: 'year', country: null, label: null, format: 'Digital' },
      recordings: [
        ...plan().recordings,
        { key: 'm-rec3', mbid: 'm-rec3', title: 'Bonus', length_ms: null, first_release_date: null, date_precision: 'unknown', isrc: null, work_key: null },
      ],
      tracks: [...plan().tracks, { recording_key: 'm-rec3', disc: 1, position: 3, title_on_release: null }],
    });
    const second = await writePlan(deluxe);
    expect(second.releaseGroupId).toBe(first.releaseGroupId);
    expect(second.createdRelease).toBe(true);
    expect(count('release_group')).toBe(1);
    expect(count('release')).toBe(2);
    expect(count('recording')).toBe(3);
    expect(count('track')).toBe(5);
  });

  it('fills nulls and never overwrites what is there', async () => {
    await writePlan(plan());
    db.exec("UPDATE artist SET disambiguation = 'hand-written' WHERE mbid = 'm-artist'");

    await writePlan(
      plan({
        artists: [{ key: 'm-artist', mbid: 'm-artist', name: 'Renamed', sort_name: 'Renamed', disambiguation: 'from import' }],
        recordings: [
          { key: 'm-rec1', mbid: 'm-rec1', title: 'One', length_ms: 9999, first_release_date: null, date_precision: 'unknown', isrc: null, work_key: 'm-work' },
          { key: 'm-rec2', mbid: 'm-rec2', title: 'Two', length_ms: 2000, first_release_date: '2019-04', date_precision: 'month', isrc: 'GBAAA1900001', work_key: null },
        ],
      }),
    );

    expect(db.prepare("SELECT name, disambiguation FROM artist WHERE mbid = 'm-artist'").get()).toMatchObject({
      name: 'Artist',
      disambiguation: 'hand-written',
    });
    // rec1 already had a length: kept. rec2 had none: filled, date and precision together.
    expect(db.prepare("SELECT length_ms FROM recording WHERE mbid = 'm-rec1'").get()!.length_ms).toBe(1000);
    expect(db.prepare("SELECT length_ms, first_release_date, date_precision, isrc FROM recording WHERE mbid = 'm-rec2'").get()).toMatchObject({
      length_ms: 2000,
      first_release_date: '2019-04',
      date_precision: 'month',
      isrc: 'GBAAA1900001',
    });
  });

  it('recognises an artist first imported from Spotify, and gives it the MusicBrainz id', async () => {
    db.prepare(`INSERT INTO artist (id, name, sort_name, spotify_id, source) VALUES ('from-spotify', 'artist', 'Artist', 'sp-1', 'spotify')`).run();
    await writePlan(plan());
    expect(db.prepare(`SELECT id, mbid, spotify_id FROM artist`).all()).toEqual([{ id: 'from-spotify', mbid: 'm-artist', spotify_id: 'sp-1' }]);
  });

  it('never joins two artists whose MusicBrainz ids differ, whatever their names', async () => {
    db.prepare(`INSERT INTO artist (id, name, sort_name, mbid, source) VALUES ('other', 'Artist', 'Artist', 'another-mbid', 'musicbrainz')`).run();
    await writePlan(plan());
    expect(count('artist')).toBe(2);
  });

  it('keeps the credits of a track edited by hand exactly as they are', async () => {
    await writePlan(plan());
    const rec = db.prepare(`SELECT id FROM recording WHERE mbid = 'm-rec2'`).get()!.id as string;
    db.prepare(`INSERT INTO app_user (id, email, display_name, is_owner) VALUES ('u', 'u@example.com', 'U', 1)`).run();
    db.prepare(`INSERT INTO field_override (entity_type, entity_id, field, value_json, user_id) VALUES ('recording', ?, 'credits', 'true', 'u')`).run(rec);
    await writePlan(plan({ credits: [...plan().credits, { entity: 'recording', entity_key: 'm-rec2', artist_key: 'm-artist', role: 'writer', position: 1, credited_as: null, join_phrase: '' }] }));
    expect(db.prepare(`SELECT count(*) AS n FROM artist_credit WHERE entity_id = ?`).get(rec)).toEqual({ n: 0 });
  });

  it('titles a recording as its release styles it, when only the capitals differ', async () => {
    const p = plan();
    p.tracks = [{ ...p.tracks[0]!, title_on_release: 'ONE' }, { ...p.tracks[1]!, title_on_release: 'Two (Live)' }];
    await writePlan(p);
    expect(db.prepare(`SELECT title FROM recording ORDER BY mbid`).all()).toEqual([{ title: 'ONE' }, { title: 'Two' }]);
  });

  it('writes nothing when any part fails', async () => {
    const broken = plan({
      tracks: [{ recording_key: 'm-rec1', disc: 1, position: 0, title_on_release: null }], // position must be >= 1
    });
    await expect(writePlan(broken)).rejects.toThrow();
    expect(count('release_group')).toBe(0);
    expect(count('recording')).toBe(0);
  });
});

describe('precise credit roles', () => {
  const credit = (role: string, extra: Record<string, string> = {}) => ({
    entity: 'recording' as const,
    entity_key: 'm-rec1',
    artist_key: 'm-artist',
    role,
    position: 1,
    credited_as: null,
    join_phrase: '',
    ...extra,
  });
  const roleOf = (db: DatabaseSync) =>
    (db.prepare(`SELECT role FROM artist_credit WHERE entity_type = 'recording' AND role <> 'primary' ORDER BY role`).all() as { role: string }[]).map((r) => r.role);

  it('adds a role the library lacks and credits it', async () => {
    await writePlan(plan({ credits: [...plan().credits, credit('theremin')], roles: [{ id: 'theremin', label: 'Theremin', family: 'performance' }] }));
    expect(db.prepare(`SELECT label, family FROM credit_role WHERE id = 'theremin'`).get()).toEqual({ label: 'Theremin', family: 'performance' });
    expect(roleOf(db)).toEqual(['theremin']);
  });

  it('uses the role already called that, or the coarser one, rather than failing', async () => {
    await writePlan(
      plan({
        credits: [...plan().credits, credit('lead_vox', { fallback_role: 'lead_vocals' }), credit('nowhere', { fallback_role: 'guitar' })],
        // Its name is taken by a built-in role with another id.
        roles: [{ id: 'lead_vox', label: 'Lead vocals', family: 'performance' }],
      }),
    );
    expect(roleOf(db)).toEqual(['guitar', 'lead_vocals']);
  });
});
