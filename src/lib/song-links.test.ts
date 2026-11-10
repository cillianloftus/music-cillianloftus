import { env } from 'cloudflare:workers';
import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { migratedDb, seedLibrary } from '../test/db';
import { fillSongLinks, keepSongLinks, songLinks, type SongLink } from './genius';
import { artistSampling, bySongs, trackLinks } from './song-links';

let db: DatabaseSync;

beforeEach(() => {
  db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
});

const page = (slug: string) => `https://genius.com/${slug}-lyrics`;
const summary = (slug: string, title: string, artist: string, year: number | null) => ({
  title,
  url: page(slug),
  primary_artist_names: artist,
  release_date_components: year ? { year, month: null, day: null } : null,
});

describe('song links from Genius', () => {
  it('reads each kind one way round, the song that takes first, and skips covers and remixes', () => {
    const links = songLinks({
      ...summary('X-a1', 'Song A1', 'Xavier', 2020),
      song_relationships: [
        { relationship_type: 'samples', songs: [summary('Old-break', 'Break', 'Old Band', 1971)] },
        { relationship_type: 'sampled_in', songs: [summary('New-flip', 'Flip', 'Newer', 2023)] },
        { relationship_type: 'interpolated_by', songs: [summary('Hook-x', 'Hook', 'Someone', null)] },
        { relationship_type: 'covered_by', songs: [summary('Cover-x', 'Cover', 'Coverer', 2022)] },
      ],
    });
    expect(links.map((l) => `${l.song.title} ${l.kind} ${l.source.title}`)).toEqual([
      'Song A1 samples Break',
      'Flip samples Song A1',
      'Hook interpolates Song A1',
    ]);
    expect(links[0]!.source).toEqual({ url: page('Old-break'), title: 'Break', artist: 'Old Band', year: 1971 });
  });

  it('joins both ends in the library through their Genius pages, and keeps a link once', async () => {
    db.exec(`UPDATE recording SET genius_url = '${page('X-a1')}' WHERE id = 'a1'`);
    db.exec(`UPDATE recording SET genius_url = '${page('X-b1')}' WHERE id = 'b1'`);
    const a1 = { url: page('X-a1'), title: 'Song A1', artist: 'Xavier', year: 2020 };
    const links: SongLink[] = [
      { kind: 'samples', song: { url: page('X-b1'), title: 'Song B1', artist: 'Xavier', year: 2022 }, source: a1 },
      { kind: 'samples', song: a1, source: { url: page('Old-break'), title: 'Break', artist: 'Old Band', year: 1971 } },
      { kind: 'interpolates', song: { url: page('Elsewhere'), title: 'Elsewhere', artist: 'Them', year: 2024 }, source: a1 },
    ];
    expect(await keepSongLinks(links)).toBe(3);
    expect(await keepSongLinks(links)).toBe(0);

    const around = await trackLinks('a1');
    expect(around.samples).toEqual([{ title: 'Break', artist: 'Old Band', year: 1971, url: page('Old-break'), recording_id: null }]);
    expect(around.sampledIn.map((t) => t.recording_id)).toEqual(['b1']);
    expect(around.interpolatedIn.map((t) => t.title)).toEqual(['Elsewhere']);
    expect((await trackLinks('b1')).samples.map((t) => t.recording_id)).toEqual(['a1']);
    expect(await trackLinks('a2')).toEqual({ samples: [], interpolates: [], sampledIn: [], interpolatedIn: [] });
  });

  it('fills tracks matched before links were kept, once each, and only from the song already taken', async () => {
    (env as unknown as { GENIUS_ACCESS_TOKEN: string }).GENIUS_ACCESS_TOKEN = 'test';
    db.exec(`UPDATE recording SET genius_url = '${page('X-a2')}' WHERE id = 'a2'`);
    db.exec(`UPDATE recording SET genius_url = '${page('X-a3-old')}' WHERE id = 'a3'`);
    const fetcher = (async (url: string) => {
      const json = url.includes('/search')
        ? { hits: ['A2', 'A3'].filter((t) => url.includes(t)).map((t) => ({ result: { id: t === 'A2' ? 2 : 3, title: `Song ${t}`, primary_artist: { name: 'Xavier' } } })) }
        : {
            song: {
              ...(url.includes('/songs/2') ? summary('X-a2', 'Song A2', 'Xavier', 2020) : summary('X-a3-new', 'Song A3', 'Xavier', 2020)),
              song_relationships: [{ relationship_type: 'samples', songs: [summary('Old-break', 'Break', 'Old Band', 1971)] }],
            },
          };
      return new Response(JSON.stringify({ response: json }));
    }) as typeof fetch;
    const report = await fillSongLinks({ budgetMs: 5000, fetcher });
    expect(report).toMatchObject({ looked: 2, links: 1, left: 0 });
    expect((await trackLinks('a2')).samples.map((t) => t.title)).toEqual(['Break']);
    // a3's search now finds another page than the one kept for it: not taken.
    expect((await trackLinks('a3')).samples).toEqual([]);
    expect((await fillSongLinks({ budgetMs: 5000, fetcher })).looked).toBe(0);
    delete (env as unknown as { GENIUS_ACCESS_TOKEN?: string }).GENIUS_ACCESS_TOKEN;
  });
});

describe('an artist’s samples', () => {
  it('names whom their songs take from and who takes from them, by artist, leaving themselves out', async () => {
    db.exec(`UPDATE recording SET genius_url = '${page('X-a1')}' WHERE id = 'a1'`);
    db.exec(`UPDATE recording SET genius_url = '${page('Y-c1')}' WHERE id = 'c1'`);
    const a1 = { url: page('X-a1'), title: 'Song A1', artist: 'Xavier', year: 2020 };
    await keepSongLinks([
      { kind: 'samples', song: a1, source: { url: page('Old-break'), title: 'Break', artist: 'Old Band', year: 1971 } },
      { kind: 'interpolates', song: a1, source: { url: page('Old-hook'), title: 'Hook', artist: 'Old Band', year: 1972 } },
      { kind: 'samples', song: a1, source: { url: page('X-early'), title: 'Early', artist: 'Xavier', year: 2010 } },
      { kind: 'samples', song: { url: page('Y-c1'), title: 'Song C1', artist: 'Yolanda', year: 2023 }, source: a1 },
      { kind: 'samples', song: { url: page('Gone'), title: 'Gone', artist: 'Deleted Artist', year: 2024 }, source: a1 },
    ]);
    const sampling = await artistSampling('art-x');
    // Their link is one of their songs that was taken.
    expect(sampling.takesFrom).toEqual([{ name: 'Old Band', id: null, url: expect.stringMatching(/Old-(break|hook)/), samples: 1, interpolations: 1 }]);
    expect(sampling.takenBy.map((a) => [a.name, a.id])).toEqual([['Yolanda', 'art-y']]);
  });

  it('puts both kinds together per artist, most songs first, whatever the case of the name', () => {
    const rows = [
      { takes: 1 as const, kind: 'samples' as const, name: 'James Brown', url: 'https://genius.com/a', n: 2 },
      { takes: 1 as const, kind: 'interpolates' as const, name: 'james brown', url: 'https://genius.com/b', n: 1 },
      { takes: 1 as const, kind: 'samples' as const, name: 'Aly-Us', url: 'https://genius.com/c', n: 1 },
      { takes: 1 as const, kind: 'interpolates' as const, name: 'Common', url: 'https://genius.com/d', n: 1 },
    ];
    expect(bySongs(rows, 2).map((a) => [a.name, a.samples, a.interpolations])).toEqual([
      ['James Brown', 2, 1],
      ['Aly-Us', 1, 0],
    ]);
  });
});
