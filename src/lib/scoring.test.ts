import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';
import { ALBUM_KEYS, CRAFT_KEYS, DEFAULT_WEIGHTS, computeScores, rank, type Weights } from './scoring';
import { activateVersion, activeWeights, saveWeights, scoreInputs, weightsForm, weightsVersions } from './weights';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

/** Deterministic, so a failure reproduces. */
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RECORDINGS = ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'c1'];
const ALBUMS = ['rg-a', 'rg-b', 'rg-c'];

/** Random rating history in the shapes the app can write. */
function randomRatings(random: () => number) {
  const half = () => Math.round(random() * 20) / 2;
  const maybe = (p: number) => (random() < p ? half() : null);
  let clock = Date.parse('2026-02-01T00:00:00Z');
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const album = random() < 0.3;
    const entity_id = album ? ALBUMS[Math.floor(random() * ALBUMS.length)]! : RECORDINGS[Math.floor(random() * RECORDINGS.length)]!;
    const keys = album ? ALBUM_KEYS : CRAFT_KEYS;
    const axes: Record<string, number | null> = Object.fromEntries(keys.map((k) => [k, maybe(0.5)]));
    // Some rows from before production split into arrangement and sound.
    if (!album && random() < 0.35) {
      delete axes.arrangement;
      delete axes.sound;
      axes.production = maybe(0.6);
    }
    const detailed = Object.values(axes).some((v) => v !== null);
    const gut = detailed ? maybe(0.6) : half();
    clock += 60_000;
    rows.push({
      id: `rand-${i}`,
      user_id: 'u-owner',
      entity_type: album ? 'release_group' : 'recording',
      entity_id,
      depth: detailed ? 'detailed' : 'gut',
      gut_score: gut,
      impact: maybe(0.3),
      rated_at: new Date(clock).toISOString(),
      ...axes,
    });
  }
  return rows;
}

function randomWeights(random: () => number): Weights {
  const axis = () => Math.round(random() * 12) / 4;
  const craft = Object.fromEntries(CRAFT_KEYS.map((k) => [k, axis()])) as Weights['craft'];
  const album = Object.fromEntries(ALBUM_KEYS.map((k) => [k, axis()])) as Weights['album'];
  craft.songwriting ||= 1; // The form rejects all-zero groups.
  album.cohesion ||= 1;
  const tracks = Math.round(random() * 20) / 20;
  return {
    craft,
    album,
    release: {
      tracks,
      album_axes: 1 - tracks,
      trim_lowest: random() < 0.5,
      interlude: Math.round(random() * 20) / 20,
      length: random() < 0.3 ? 0 : Math.round(random() * 20) / 20,
    },
  };
}

/** Some tracks get a length, and some are marked interludes or skits. */
function randomKindsAndLengths(random: () => number) {
  for (const id of RECORDINGS) {
    if (random() < 0.8) db.prepare(`UPDATE recording SET length_ms = ? WHERE id = ?`).run(Math.round(30_000 + random() * 400_000), id);
    const roll = random();
    const kind = roll < 0.15 ? 'skit' : roll < 0.4 ? 'interlude' : roll < 0.5 ? 'song' : null;
    if (kind) insert(db, 'recording_kind', [{ recording_id: id, kind }]);
  }
}

function viewScores(view: 'v_recording_score' | 'v_release_score', key: string) {
  const rows = db
    .prepare(`SELECT ${key} AS id, quality_score, personal_score FROM ${view} WHERE user_id = 'u-owner'`)
    .all() as { id: string; quality_score: number; personal_score: number }[];
  return new Map(rows.map((r) => [r.id, { quality: r.quality_score, personal: r.personal_score }]));
}

describe('preview scoring matches the SQL views', () => {
  for (const seed of Array.from({ length: 40 }, (_, i) => i + 1)) {
    it(`seed ${seed}`, async () => {
      const random = prng(seed);
      insert(db, 'rating', randomRatings(random));
      if (seed > 1) randomKindsAndLengths(random);
      const weights = seed === 1 ? DEFAULT_WEIGHTS : randomWeights(random);
      await saveWeights('u-owner', weights);

      const preview = computeScores(await scoreInputs('u-owner'), weights);
      const calibration = db.prepare(`SELECT gut_offset, sample_size FROM v_gut_calibration WHERE user_id = 'u-owner'`).get() as {
        gut_offset: number;
        sample_size: number;
      };
      expect(preview.offset).toBeCloseTo(calibration.gut_offset, 9);
      expect(preview.samples).toBe(calibration.sample_size);

      for (const [view, key, mine] of [
        ['v_recording_score', 'recording_id', preview.recordings],
        ['v_release_score', 'release_group_id', preview.albums],
      ] as const) {
        const sql = viewScores(view, key);
        expect([...mine.keys()].sort()).toEqual([...sql.keys()].sort());
        for (const [id, score] of sql) {
          expect(mine.get(id)!.quality, `${id} quality`).toBeCloseTo(score.quality, 9);
          expect(mine.get(id)!.personal, `${id} personal`).toBeCloseTo(score.personal, 9);
        }
      }
    });
  }
});

describe('production split into arrangement and sound', () => {
  it('scores a rating and weights saved before the split exactly as before', async () => {
    // Old formula: (2 × production 6 + 1 × songwriting 8) / 3.
    insert(db, 'weights', [{ id: 'w-old', user_id: 'u-owner', version: 1, active: 1, payload_json: JSON.stringify({ craft: { production: 2, songwriting: 1 } }) }]);
    insert(db, 'rating', [{ id: 'old', user_id: 'u-owner', entity_type: 'recording', entity_id: 'a1', depth: 'detailed', production: 6, songwriting: 8, rated_at: '2030-01-01T00:00:00.000Z' }]);
    const sql = db.prepare(`SELECT quality_score FROM v_recording_score WHERE recording_id = 'a1'`).get() as { quality_score: number };
    expect(sql.quality_score).toBeCloseTo((10 * (2 * 6 + 8)) / 3, 9);
    const weights = await activeWeights('u-owner');
    expect(weights.craft).toMatchObject({ arrangement: 1, sound: 1, songwriting: 1 });
    expect(computeScores(await scoreInputs('u-owner'), weights).recordings.get('a1')!.quality).toBeCloseTo(sql.quality_score, 9);
  });

  it('scores the two halves on their own once given', () => {
    insert(db, 'rating', [{ id: 'new', user_id: 'u-owner', entity_type: 'recording', entity_id: 'a1', depth: 'detailed', arrangement: 4, sound: 8, rated_at: '2030-01-01T00:00:00.000Z' }]);
    const sql = db.prepare(`SELECT quality_score FROM v_recording_score WHERE recording_id = 'a1'`).get() as { quality_score: number };
    expect(sql.quality_score).toBeCloseTo(60, 9);
  });
});

describe('ranking', () => {
  it('orders best first, ties by id', () => {
    const scores = new Map([
      ['b', { quality: 50, personal: 60 }],
      ['a', { quality: 50, personal: 50 }],
      ['c', { quality: 70, personal: 70 }],
    ]);
    expect(rank(scores, 'quality')).toEqual(['c', 'a', 'b']);
    expect(rank(scores, 'personal')).toEqual(['c', 'b', 'a']);
  });

  it('trimming the lowest track changes an album score', async () => {
    // Album A's canonical tracks: a1 90, a2 70, a3 50 (the deluxe-only a4 is excluded).
    const inputs = await scoreInputs('u-owner');
    const trimmed = computeScores(inputs, DEFAULT_WEIGHTS).albums.get('rg-a')!;
    const plain = computeScores(inputs, { ...DEFAULT_WEIGHTS, release: { ...DEFAULT_WEIGHTS.release, trim_lowest: false } }).albums.get('rg-a')!;
    expect(trimmed.quality).toBeCloseTo(80);
    expect(plain.quality).toBeCloseTo(70);
    expect(trimmed.ratedTracks).toBe(3);
  });
});

describe('weights versions', () => {
  const form = (overrides: Record<string, string> = {}) => ({
    arrangement: '0.5',
    sound: '0.5',
    songwriting: '1',
    lyrics: '1',
    performance: '1',
    sequencing: '1',
    cohesion: '1',
    ambition: '1',
    tracks_share: '70',
    trim_lowest: 'on',
    ...overrides,
  });

  it('parses the form, deriving the album share from the tracks share', () => {
    const parsed = weightsForm.parse(form({ lyrics: '2.5', tracks_share: '60', trim_lowest: '' }));
    expect(parsed.craft.lyrics).toBe(2.5);
    expect(parsed.release).toEqual({ tracks: 0.6, album_axes: 0.4, trim_lowest: false, interlude: 0.5, length: 0 });
    expect(weightsForm.parse(form({ length_share: '40', interlude_share: '25' })).release).toMatchObject({ length: 0.4, interlude: 0.25 });
  });

  it('rejects a group with every weight at zero, and off-step values', () => {
    expect(weightsForm.safeParse(form({ arrangement: '0', sound: '0', songwriting: '0', lyrics: '0', performance: '0' })).success).toBe(false);
    expect(weightsForm.safeParse(form({ lyrics: '1.1' })).success).toBe(false);
    expect(weightsForm.safeParse(form({ lyrics: '4' })).success).toBe(false);
    expect(weightsForm.safeParse(form({ tracks_share: '101' })).success).toBe(false);
  });

  it('saving adds a version and makes it active; switching back replays the old one', async () => {
    const lyricsHeavy = weightsForm.parse(form({ lyrics: '3' }));
    const productionHeavy = weightsForm.parse(form({ sound: '3' }));
    expect(await saveWeights('u-owner', lyricsHeavy)).toBe(1);
    expect(await saveWeights('u-owner', productionHeavy)).toBe(2);
    expect((await activeWeights('u-owner')).craft.sound).toBe(3);

    const versions = await weightsVersions('u-owner');
    expect(versions.map((v) => [v.version, v.active])).toEqual([
      [2, true],
      [1, false],
    ]);

    expect(await activateVersion('u-owner', versions[1]!.id)).toBe(true);
    expect((await activeWeights('u-owner')).craft.lyrics).toBe(3);
    // The views follow the active version.
    const row = db.prepare(`SELECT w_lyrics FROM v_active_weights WHERE user_id = 'u-owner'`).get() as { w_lyrics: number };
    expect(row.w_lyrics).toBe(3);
  });

  it('saving the active weights again adds nothing', async () => {
    const w = weightsForm.parse(form({ lyrics: '2' }));
    await saveWeights('u-owner', w);
    await saveWeights('u-owner', w);
    expect(await weightsVersions('u-owner')).toHaveLength(1);
  });

  it('cannot activate another user’s version', async () => {
    await saveWeights('u-friend', weightsForm.parse(form({ lyrics: '2' })));
    const [friends] = await weightsVersions('u-friend');
    expect(await activateVersion('u-owner', friends!.id)).toBe(false);
  });
});
