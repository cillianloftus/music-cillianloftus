import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { insert, insertPlays, migratedDb, seedLibrary } from '../test/db';
import { artistTopTracks } from './catalogue';
import { fillPlayMonths, trackListening } from './history';
import { credentials, forget, saveCredentials, stateOf } from './connections';
import { artistBreakdown, trackFacts } from './discover';
import { artistNames, parseCursor, syncScrobbles } from './scrobbles';
import type { Scrobble } from './sources/lastfm';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

afterEach(() => {
  delete (env as unknown as { LASTFM_API_KEY?: string }).LASTFM_API_KEY;
});

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** A stand-in service holding these scrobbles, answering two at a time, newest first. */
function service(scrobbles: Scrobble[], pageSize = 2) {
  const calls: { after: number; before: number }[] = [];
  const fetchPage = async (window: { after: number; before: number }) => {
    calls.push({ ...window });
    return scrobbles
      .filter((s) => s.at > window.after && s.at < window.before)
      .sort((a, b) => b.at - a.at)
      .slice(0, pageSize);
  };
  return { fetchPage, calls };
}

const plays = () => db.prepare(`SELECT recording_id, played_at, source FROM play ORDER BY played_at`).all();

describe('connection keys', () => {
  it('takes a pasted key, and a Worker secret over it', async () => {
    expect(await credentials('lastfm')).toBeNull();
    expect(await saveCredentials('lastfm', { api_key: '0123456789abcdef0123456789abcdef', username: 'cillian' })).toEqual({});
    expect(await credentials('lastfm')).toEqual({ api_key: '0123456789abcdef0123456789abcdef', username: 'cillian' });

    (env as unknown as { LASTFM_API_KEY: string }).LASTFM_API_KEY = 'ffffffffffffffffffffffffffffffff';
    expect((await credentials('lastfm'))?.api_key).toBe('ffffffffffffffffffffffffffffffff');
  });

  it('refuses something that is plainly not the key, and keeps what was there', async () => {
    await saveCredentials('discogs', { token: 'abcdefghijklmnopqrstuvwxyz' });
    const problems = await saveCredentials('discogs', { token: 'my password!' });
    expect(problems.token).toMatch(/doesn’t look like a Discogs/);
    expect((await credentials('discogs'))?.token).toBe('abcdefghijklmnopqrstuvwxyz');
  });

  it('works without an optional field, never without a required one', async () => {
    await saveCredentials('listenbrainz', { username: 'cillian' });
    expect(await credentials('listenbrainz')).toEqual({ username: 'cillian' });
    await saveCredentials('lastfm', { username: 'cillian' });
    expect(await credentials('lastfm')).toBeNull();
  });

  it('forgets', async () => {
    await saveCredentials('setlistfm', { api_key: 'abcdefghij-klmnopqrst-uvwxyz' });
    await forget('setlistfm');
    expect(await credentials('setlistfm')).toBeNull();
  });
});

describe('scrobble sync', () => {
  const library: Scrobble[] = [
    { artist: 'Xavier', title: 'Song A1', album: 'Album A', mbid: null, at: at('2026-02-01T10:00:00Z') },
    { artist: 'Xavier feat. Yolanda', title: 'Song A2', album: null, mbid: null, at: at('2026-02-01T10:05:00Z') },
    { artist: 'Nobody Here', title: 'Song A1', album: null, mbid: null, at: at('2026-02-01T10:10:00Z') },
    { artist: 'XAVIER', title: 'song b1', album: null, mbid: null, at: at('2026-02-02T09:00:00Z') },
    { artist: 'Xavier', title: 'Song A1', album: 'Album A', mbid: null, at: at('2026-02-03T09:00:00Z') },
  ];

  it('takes every page, keeps every scrobble (matched where the library has it), and remembers where it got to', async () => {
    const { fetchPage } = service(library);
    const report = await syncScrobbles('lastfm', { budgetMs: 10_000, fetchPage });
    expect(report).toMatchObject({ fetched: 5, added: 5, complete: true });
    expect(plays()).toEqual([
      { recording_id: 'a1', played_at: '2026-02-01T10:00:00.000Z', source: 'lastfm' },
      { recording_id: 'a2', played_at: '2026-02-01T10:05:00.000Z', source: 'lastfm' },
      { recording_id: null, played_at: '2026-02-01T10:10:00.000Z', source: 'lastfm' },
      { recording_id: 'b1', played_at: '2026-02-02T09:00:00.000Z', source: 'lastfm' },
      { recording_id: 'a1', played_at: '2026-02-03T09:00:00.000Z', source: 'lastfm' },
    ]);
    expect(parseCursor((await stateOf('lastfm'))!.cursor).pending).toBeUndefined();
  });

  it('asks only for the last two weeks the next time, catching late scrobbles', async () => {
    const first = service(library);
    await syncScrobbles('lastfm', { budgetMs: 10_000, fetchPage: first.fetchPage });
    // Played offline three days ago, sent in after that sync.
    const late = { artist: 'Xavier', title: 'Song B2', album: null, mbid: null, at: Math.floor(Date.now() / 1000) - 3 * 86400 };
    const later = service([...library, late]);
    const report = await syncScrobbles('lastfm', { budgetMs: 10_000, fetchPage: later.fetchPage });
    expect(report).toMatchObject({ fetched: 1, added: 1 });
    expect(later.calls.every((c) => c.after > at('2026-02-03T09:00:00Z'))).toBe(true);
  });

  it('picks up where a run that ran out of time stopped', async () => {
    const { fetchPage } = service(library);
    const cut = await syncScrobbles('lastfm', { budgetMs: -1, fetchPage });
    expect(cut.complete).toBe(false);
    expect(parseCursor((await stateOf('lastfm'))!.cursor).pending).toBeDefined();
    const rest = await syncScrobbles('lastfm', { budgetMs: 10_000, fetchPage });
    expect(rest.complete).toBe(true);
    expect(plays()).toHaveLength(5);
  });

  it('never counts the same play twice', async () => {
    const { fetchPage } = service(library);
    await syncScrobbles('listenbrainz', { budgetMs: 10_000, fetchPage });
    db.prepare(`DELETE FROM connection_state`).run();
    const again = await syncScrobbles('listenbrainz', { budgetMs: 10_000, fetchPage });
    expect(again).toMatchObject({ fetched: 5, added: 0 });
  });

  it('matches by MusicBrainz id before anything else', async () => {
    db.prepare(`UPDATE recording SET mbid = '11111111-1111-1111-1111-111111111111' WHERE id = 'b2'`).run();
    const { fetchPage } = service([{ artist: 'Some Alias', title: 'Different Title', album: null, mbid: '11111111-1111-1111-1111-111111111111', at: at('2026-03-01T00:00:00Z') }]);
    await syncScrobbles('listenbrainz', { budgetMs: 10_000, fetchPage });
    expect(plays()).toEqual([{ recording_id: 'b2', played_at: '2026-03-01T00:00:00.000Z', source: 'listenbrainz' }]);
  });

  it('splits credits the way scrobblers write them', () => {
    expect(artistNames('Xavier feat. Yolanda')).toEqual(['xavier feat yolanda', 'xavier', 'yolanda']);
    expect(artistNames('Simon & Garfunkel')).toEqual(['simon and garfunkel', 'simon', 'garfunkel']);
  });
});

describe('favourites', () => {
  it('are the best rated until there are plays, then plays count too', async () => {
    expect((await artistTopTracks('art-x', 'u-owner', 3)).map((t) => t.id)).toEqual(['a4', 'a1', 'b1']);
    // b2 (rated 60) played far more than anything else.
    insertPlays(
      db,
      Array.from({ length: 40 }, (_, i) => ({
        id: `p${i}`,
        user_id: 'u-owner',
        recording_id: 'b2',
        played_at: `2026-04-01T00:${String(i).padStart(2, '0')}:00Z`,
        ms_played: 200000,
        source: 'lastfm',
      })),
    );
    const top = await artistTopTracks('art-x', 'u-owner', 3);
    expect(top[0]).toMatchObject({ id: 'b2', plays: 40 });
  });
});

describe('track facts', () => {
  it('describes each rated track from the real schema', async () => {
    const facts = await trackFacts('u-owner');
    expect(facts).toHaveLength(7);
    const b2 = facts.find((f) => f.id === 'b2')!;
    expect(b2.credits.map((c) => c.role).sort()).toEqual(['primary', 'producer']);
    expect(b2.genres.map((g) => g.name).sort()).toEqual(['bedroom pop', 'rock']);
    expect(facts.find((f) => f.id === 'a4')).toMatchObject({ extra: true, position: null });
    expect(facts.find((f) => f.id === 'a2')).toMatchObject({ position: 2, size: 3, extra: false });
  });

  it('narrows to a genre: the track’s own genre first, else its album’s', async () => {
    const rock = await trackFacts('u-owner', { genreId: 'g-rock' });
    // b2 is rock itself (on a bedroom-pop album); c1 takes rock from its album.
    expect(rock.map((f) => f.id).sort()).toEqual(['b2', 'c1']);
    const bedroom = await trackFacts('u-owner', { genreId: 'g-bedroom' });
    expect(bedroom.map((f) => f.id)).toEqual(['b1']);
  });

  it('narrows to an album, deluxe tracks included', async () => {
    expect((await trackFacts('u-owner', { albumId: 'rg-a' })).map((f) => f.id).sort()).toEqual(['a1', 'a2', 'a3', 'a4']);
  });

  it('gives an artist their breakdown', async () => {
    const b = await artistBreakdown('u-owner', 'art-x');
    expect(b).toMatchObject({ rated: 6, best: { id: 'a4' }, worst: { id: 'a3' }, rank: { position: 1, of: 1 } });
    // Yolanda has one rated track: too few to be ranked against.
  });
});

describe('a track’s listening', () => {
  it('fills the quiet months and ranks it among everything played', async () => {
    const play = (id: string, recording_id: string, played_at: string) => ({ id, user_id: 'u-owner', recording_id, played_at, ms_played: 1, source: 'lastfm' });
    insertPlays(db, [play('1', 'a1', '2026-01-05T00:00:00Z'), play('2', 'a1', '2026-03-05T00:00:00Z'), play('3', 'a2', '2026-01-01T00:00:00Z'), play('4', 'a2', '2026-01-02T00:00:00Z'), play('5', 'a2', '2026-01-03T00:00:00Z')]);
    const l = await trackListening('u-owner', 'a1', new Date('2026-04-10T00:00:00Z'));
    expect(l).toMatchObject({ total: 2, rank: 2, of: 2, sources: ['lastfm'] });
    expect(l!.months).toEqual([
      { month: '2026-01', count: 1 },
      { month: '2026-02', count: 0 },
      { month: '2026-03', count: 1 },
      { month: '2026-04', count: 0 },
    ]);
    expect(await trackListening('u-owner', 'b1')).toBeNull();
  });

  it('crosses a year end', () => {
    expect(fillPlayMonths([{ month: '2025-12', count: 1 }, { month: '2026-01', count: 2 }]).map((m) => m.month)).toEqual(['2025-12', '2026-01']);
  });
});
