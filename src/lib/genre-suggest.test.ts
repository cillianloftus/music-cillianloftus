import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { migratedDb, seedLibrary } from '../test/db';
import { parseGenrePage } from '../../scripts/mb-genre-relations';
import { clearPlacements, dismissedSuggestions, dismissSuggestion, suggestParents, type MbRelations } from './genre-suggest';

const row = (id: string, name: string, parent_id: string | null = null, also: string[] = [], tracks = 1) => ({ id, name, parent_id, also, tracks });

const MB: MbRelations = {
  'pop rap': { sub: ['hip hop'], infl: ['pop'] },
  'country rock': { fusion: ['country', 'rock'] },
  'east coast hip hop': { sub: ['hip hop'] },
  'boom bap': { sub: ['east coast hip hop'] },
  'hip hop': { infl: ['funk'] },
  'bedroom pop': { sub: ['indie pop'] },
  'shoegaze': { sub: ['dream pop'] },
};

describe('suggesting parents from MusicBrainz', () => {
  it('offers library genres for each relationship, a fusion as one choice, unplaced genres first', () => {
    const rows = [
      row('hh', 'Hip-Hop'),
      row('pop', 'pop'),
      row('pr', 'pop rap', null, [], 5),
      row('country', 'country'),
      row('rock', 'rock'),
      row('cr', 'country rock', null, [], 2),
    ];
    const out = suggestParents(rows, MB);
    expect(out.map((s) => s.name)).toEqual(['pop rap', 'country rock']);
    const pr = out[0];
    // Spelling-insensitive: "hip hop" finds "Hip-Hop".
    expect(pr.picks).toEqual([
      { id: 'hh', name: 'Hip-Hop', relation: 'sub' },
      { id: 'pop', name: 'pop', relation: 'infl' },
    ]);
    expect(pr.fusion).toBeNull();
    expect(out[1].fusion?.map((p) => p.id)).toEqual(['country', 'rock']);
  });

  it('climbs to the nearest library genre above one that is missing, and names what MusicBrainz said', () => {
    const out = suggestParents([row('hh', 'hip hop'), row('bb', 'boom bap')], MB);
    expect(out[0].picks).toEqual([{ id: 'hh', name: 'hip hop', relation: 'sub', via: 'east coast hip hop' }]);
  });

  it('offers a missing parent for adding when nothing above it is here, but not a missing influence', () => {
    const out = suggestParents([row('sg', 'shoegaze'), row('hh', 'hip hop')], MB);
    expect(out).toHaveLength(1);
    expect(out[0].picks).toEqual([{ id: null, name: 'dream pop', relation: 'sub' }]);
  });

  it('leaves out parents already linked, anything that would loop, and what was turned down', () => {
    const rows = [row('pop', 'pop'), row('ip', 'indie pop', 'pop'), row('bp', 'bedroom pop', 'ip'), row('hh', 'hip hop'), row('pr', 'pop rap', 'hh')];
    // Bedroom pop is already beneath indie pop; pop rap beneath hip hop.
    const out = suggestParents(rows, MB);
    expect(out.map((s) => s.name)).toEqual(['pop rap']);
    expect(out[0]).toMatchObject({ placed: true, picks: [{ id: 'pop', relation: 'infl' }] });
    // Pop is an ancestor of… nothing here, but turned down it goes.
    expect(suggestParents(rows, MB, [{ genre_id: 'pr', parent_key: 'pop' }])).toEqual([]);
    // Hip hop beneath pop rap would loop: not offered.
    const looped = [row('pr', 'pop rap'), row('hh', 'hip hop', 'pr')];
    expect(suggestParents(looped, MB)).toEqual([]);
  });

  it('files only the clear-cut: one parent, or every part of a fusion', () => {
    const rows = [
      row('hh', 'hip hop'),
      row('pop', 'pop'),
      row('pr', 'pop rap'),
      row('country', 'country'),
      row('rock', 'rock'),
      row('cr', 'country rock'),
      row('sg', 'shoegaze'),
    ];
    const clear = clearPlacements(suggestParents(rows, MB));
    expect(clear.map((c) => [c.name, c.parents.map((p) => p.name)])).toEqual([
      ['country rock', ['country', 'rock']],
      ['pop rap', ['hip hop']],
    ]);
  });
});

describe('turning suggestions down', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = migratedDb();
    seedLibrary(db);
    (env as { DB: D1Database }).DB = d1(db);
  });

  it('remembers by name key, once', async () => {
    await dismissSuggestion('g-rock', 'Hip-Hop');
    await dismissSuggestion('g-rock', 'hip hop');
    expect(await dismissedSuggestions()).toEqual([{ genre_id: 'g-rock', parent_key: 'hip hop' }]);
  });
});

describe('reading a MusicBrainz genre page', () => {
  it('takes subgenre-of, fusion-of and influenced-by, and ignores the inverse rows', () => {
    const cell = (names: string[]) =>
      `<td style="x">${names.map((n, i) => `<span class="genrelink"></span><a class="wrap-anywhere" href="/genre/0000000${i}-aaaa"><bdi>${n}</bdi></a><br/>`).join('')}</td>`;
    const html =
      `<tr><th>fusion of:</th>${cell(['country', 'rock &amp; roll'])}</tr>` +
      `<tr><th>subgenres:</th>${cell(['heartland rock'])}</tr>` +
      `<tr><th>subgenre of:</th>${cell(['Rock'])}</tr>` +
      `<tr><th>influenced by:</th>${cell(['folk'])}</tr>` +
      `<tr><th>influenced genres:</th>${cell(['alt-country'])}</tr>`;
    expect(parseGenrePage(html)).toEqual({ fusion: ['country', 'rock & roll'], sub: ['rock'], infl: ['folk'] });
  });
});
