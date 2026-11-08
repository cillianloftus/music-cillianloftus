import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, migratedDb, seedLibrary } from '../test/db';
import { addCredit, addRole, editTrackTitle, fillCredits, recordingCredits, removeCredit, removeRole } from './credits';
import { EditError } from './edits';
import { missingInfo } from './gaps';
import { fillCreditsFromGenius, geniusTitleKey } from './genius';
import { mergeAlbums, mergeArtists } from './merge';
import { detectAnomalies } from './review';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

const roles = async (id: string) => (await recordingCredits(id)).map((c) => `${c.role}:${c.name}`);

describe('track credits by hand', () => {
  it('adds and removes credits, creating new artists, and marks them as edited', async () => {
    expect(await addCredit('u-owner', 'a2', { role: 'writer', name: 'yolanda' })).toEqual({ created: false });
    expect(await addCredit('u-owner', 'a2', { role: 'producer', name: 'Newcomer' })).toEqual({ created: true });
    expect(await roles('a2')).toEqual(['primary:Xavier', 'writer:Yolanda', 'producer:Newcomer']);
    await expect(addCredit('u-owner', 'a2', { role: 'writer', name: 'Yolanda' })).rejects.toThrow(EditError);

    const writer = (await recordingCredits('a2')).find((c) => c.role === 'writer')!;
    await removeCredit('u-owner', 'a2', writer.id);
    expect(await roles('a2')).toEqual(['primary:Xavier', 'producer:Newcomer']);
    expect(db.prepare(`SELECT field FROM field_override WHERE entity_id = 'a2'`).all()).toEqual([{ field: 'credits' }]);
  });

  it('never removes the last artist', async () => {
    const primary = (await recordingCredits('a1')).find((c) => c.role === 'primary')!;
    await expect(removeCredit('u-owner', 'a1', primary.id)).rejects.toThrow(/at least one artist/);
  });

  it('keeps a title exactly as styled', async () => {
    await editTrackTitle('u-owner', 'a2', 'SONG a2');
    expect(db.prepare(`SELECT title FROM recording WHERE id = 'a2'`).get()).toEqual({ title: 'SONG a2' });
  });

  it('fills only empty roles, and never a track edited by hand', async () => {
    expect(await fillCredits('b2', [{ role: 'writer', name: 'Xavier' }, { role: 'producer', name: 'Someone Else' }])).toBe(1);
    expect(await roles('b2')).toEqual(['primary:Xavier', 'writer:Xavier', 'producer:Pat Producer']);

    await addCredit('u-owner', 'a3', { role: 'producer', name: 'Pat Producer' });
    expect(await fillCredits('a3', [{ role: 'writer', name: 'Xavier' }])).toBe(0);
  });
});

describe('Genius', () => {
  it('drops featuring tails and stylisation from titles', () => {
    expect(geniusTitleKey('dustcutter (Ft. Someone)')).toBe(geniusTitleKey('DUSTCUTTER'));
  });

  it('takes writers only from a song whose title and artist both match', async () => {
    (env as unknown as { GENIUS_ACCESS_TOKEN: string }).GENIUS_ACCESS_TOKEN = 'test';
    const fetcher = (async (url: string) => {
      const json = url.includes('/search')
        ? url.includes('A2')
          ? { hits: [{ result: { id: 1, title: 'Song A2', primary_artist: { name: 'Someone Else' } } }, { result: { id: 2, title: 'SONG A2', primary_artist: { name: 'Xavier' } } }] }
          : { hits: [] }
        : { song: { writer_artists: [{ name: 'Xavier' }, { name: 'Brand New Writer' }], producer_artists: [] } };
      expect(url).not.toContain('/songs/1');
      return new Response(JSON.stringify({ response: json }));
    }) as typeof fetch;
    const report = await fillCreditsFromGenius({ albumId: 'rg-a', budgetMs: 5000, fetcher });
    expect(report).toMatchObject({ matched: 1, added: 2 });
    expect(await roles('a2')).toEqual(['primary:Xavier', 'writer:Xavier', 'writer:Brand New Writer']);
    // Looked up once, not again for a while.
    expect((await fillCreditsFromGenius({ albumId: 'rg-a', budgetMs: 5000, fetcher })).looked).toBe(0);
    delete (env as unknown as { GENIUS_ACCESS_TOKEN?: string }).GENIUS_ACCESS_TOKEN;
  });
});

describe('merging artists', () => {
  it('moves everything onto the kept artist, fills its gaps, and redirects the old id', async () => {
    insert(db, 'artist', [
      { id: 'jl-spotify', name: 'John Lindahl', sort_name: 'Lindahl, John', spotify_id: 'sp1', source: 'spotify' },
      { id: 'jl-mb', name: 'John Lindahl', sort_name: 'Lindahl, John', mbid: 'mb1', source: 'musicbrainz' },
    ]);
    insert(db, 'artist_credit', [
      { id: 'k1', entity_type: 'recording', entity_id: 'b1', artist_id: 'jl-mb', role: 'primary', position: 2, join_phrase: '' },
      { id: 'g1', entity_type: 'recording', entity_id: 'b1', artist_id: 'jl-spotify', role: 'primary', position: 3, join_phrase: '' },
      { id: 'g2', entity_type: 'recording', entity_id: 'a3', artist_id: 'jl-spotify', role: 'writer', position: 1, join_phrase: '' },
    ]);
    db.prepare(`UPDATE artist_credit SET join_phrase = ' & ' WHERE entity_id = 'b1' AND artist_id = 'art-x'`).run();

    expect((await detectAnomalies()).open).toBeGreaterThan(0);
    await mergeArtists('jl-mb', 'jl-spotify');

    expect(db.prepare(`SELECT id, mbid, spotify_id FROM artist WHERE name = 'John Lindahl'`).all()).toEqual([{ id: 'jl-mb', mbid: 'mb1', spotify_id: 'sp1' }]);
    expect(await roles('b1')).toEqual(['primary:Xavier', 'primary:John Lindahl']);
    expect(await roles('a3')).toContain('writer:John Lindahl');
    expect(db.prepare(`SELECT new_id FROM entity_redirect WHERE old_id = 'jl-spotify'`).get()).toEqual({ new_id: 'jl-mb' });
    expect(db.prepare(`SELECT count(*) AS n FROM anomaly WHERE kind = 'duplicate_artist_name' AND status = 'open'`).get()).toEqual({ n: 0 });
  });
});

describe('folding one album into another', () => {
  it('raises "Title: Subtitle" beside "Title", and moves the editions across', async () => {
    insert(db, 'release_group', [{ id: 'rg-a2', title: 'Album A: The Complete Score', type: 'album', source: 'spotify', spotify_id: 'sp-a2' }]);
    insert(db, 'release', [{ id: 'r-a2', release_group_id: 'rg-a2', title: 'Album A: The Complete Score', source: 'spotify' }]);
    insert(db, 'artist_credit', [{ id: 'c-a2', entity_type: 'release_group', entity_id: 'rg-a2', artist_id: 'art-x', role: 'primary' }]);
    await detectAnomalies();
    expect(db.prepare(`SELECT entity_a, entity_b FROM anomaly WHERE kind = 'near_duplicate_release_group' AND status = 'open'`).all()).toEqual([
      { entity_a: 'rg-a', entity_b: 'rg-a2' },
    ]);

    await mergeAlbums('rg-a', 'rg-a2');
    expect(db.prepare(`SELECT release_group_id FROM release WHERE id = 'r-a2'`).get()).toEqual({ release_group_id: 'rg-a' });
    expect(db.prepare(`SELECT spotify_id FROM release_group WHERE id = 'rg-a'`).get()).toEqual({ spotify_id: 'sp-a2' });
    expect(db.prepare(`SELECT count(*) AS n FROM release_group WHERE id = 'rg-a2'`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT new_id FROM entity_redirect WHERE old_id = 'rg-a2'`).get()).toEqual({ new_id: 'rg-a' });
  });

  it('brings the album ratings of the one going away, and keeps its row in the redirect', async () => {
    insert(db, 'rating', [{ id: 'rr', user_id: 'u-owner', entity_type: 'release_group', entity_id: 'rg-b', depth: 'gut', gut_score: 7 }]);
    await mergeAlbums('rg-a', 'rg-b');
    expect(db.prepare(`SELECT entity_id FROM rating WHERE id = 'rr'`).get()).toEqual({ entity_id: 'rg-a' });
    const redirect = db.prepare(`SELECT new_id, snapshot_json FROM entity_redirect WHERE old_id = 'rg-b'`).get() as { new_id: string; snapshot_json: string };
    expect(redirect.new_id).toBe('rg-a');
    expect(JSON.parse(redirect.snapshot_json).title).toBe('Album B');
  });
});

describe('missing information', () => {
  it('lists what is not known yet', async () => {
    const gaps = await missingInfo();
    const writers = gaps.find((g) => g.key === 'writers')!;
    expect(writers.total).toBe(3);
    expect(gaps.find((g) => g.key === 'spotify')!.total).toBe(3);
    expect(gaps.some((g) => g.key === 'dates')).toBe(false);
  });
});

describe('credit roles', () => {
  it('can be added, used, and removed only once unused', async () => {
    expect(await addRole('Vocal Arrangement', 'performance')).toBe('vocal_arrangement');
    await expect(addRole('vocal arrangement', 'performance')).rejects.toThrow(/already/);
    await addCredit('u-owner', 'a2', { role: 'vocal_arrangement', name: 'Yolanda' });
    expect((await recordingCredits('a2')).find((c) => c.role === 'vocal_arrangement')?.role_label).toBe('Vocal Arrangement');
    await expect(removeRole('vocal_arrangement')).rejects.toThrow(/still used/);
    await expect(removeRole('writer')).rejects.toThrow(/Built-in/);
  });
});
