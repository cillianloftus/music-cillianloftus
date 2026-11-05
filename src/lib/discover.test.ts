import { describe, expect, it } from 'vitest';
import { favouriteScore } from './catalogue';
import { decodeDefinition } from './query/builder';
import { definitionSchema } from './query/schema';
import { discover, pearson, separation, type Credit, type TrackFact } from './discover';

const credit = (id: string, role: string, extra: Partial<Credit> = {}): Credit => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  role,
  label: role,
  family: role === 'primary' || role === 'featured' ? 'artist' : role === 'producer' ? 'production' : 'writing',
  position: 1,
  born: null,
  ...extra,
});

/** A small seeded random, so the library is the same every run. */
function random(seed: number) {
  // mulberry32
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Eighty tracks with patterns planted: whatever Rango produced scores ten
 * higher, longer songs score higher, and one track sinks its album.
 */
function library(): TrackFact[] {
  const rand = random(7);
  const facts: TrackFact[] = [];
  for (let i = 0; i < 80; i++) {
    const album = `album${i % 8}`;
    const rango = i % 4 === 0;
    const minutes = 2 + rand() * 4;
    let score = 70 + rand() * 8 + (rango ? 10 : 0) + minutes * 2;
    if (i === 9) score = 30; // the odd one out on album1
    facts.push({
      id: `t${i}`,
      title: `Track ${i}`,
      score,
      ratedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      lengthMs: minutes * 60000,
      albumId: album,
      albumTitle: `Album ${i % 8}`,
      albumType: 'album',
      released: `${2000 + (i % 8)}-01-01`,
      position: Math.floor(i / 8) + 1,
      size: 10,
      extra: false,
      label: null,
      credits: [credit(`artist${i % 5}`, 'primary'), ...(rango ? [credit('rango', 'producer')] : [credit(`other${i % 3}`, 'producer')])],
      genres: [],
      plays: 0,
      axes: { production: null, songwriting: null, lyrics: null, performance: null },
      gut: null,
    });
  }
  return facts;
}

describe('statistics', () => {
  it('measures correlation', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1);
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
  });

  it('does not take three identical scores for certainty', () => {
    const { t } = separation([100, 100, 100], [90, 91, 89, 92, 88, 90]);
    expect(Math.abs(t)).toBeLessThan(10);
  });
});

describe('discover', () => {
  const found = discover(library(), { limit: 30 });

  it('finds the producer whose tracks score higher', () => {
    const rango = found.find((f) => f.key === 'credit:production:rango:producer');
    expect(rango?.headline).toMatch(/^Tracks Rango produced average \d+, \d+ points above the rest$/);
    expect(rango?.tone).toBe('up');
    expect(rango?.href).toBe('/artist/rango/as/producer');
  });

  it('finds that longer songs score higher', () => {
    expect(found.find((f) => f.key === 'trend:length')?.headline).toBe('The longer the song, the higher you rate it');
  });

  it('finds the track that sinks its album', () => {
    const odd = found.find((f) => f.key === 'odd:t9');
    expect(odd?.headline).toBe('“Track 9” is the one you’d skip on Album 1');
    expect(odd?.tone).toBe('down');
  });

  it('says nothing about noise', () => {
    const rand = random(3);
    const flat = library().map((f) => ({ ...f, score: 80 + rand() * 4, credits: [credit('solo', 'primary')], lengthMs: null }));
    expect(discover(flat).filter((f) => f.kind !== 'trend')).toEqual([]);
  });

  it('spreads the page across kinds before repeating one', () => {
    const top = discover(library(), { limit: 4 });
    const kinds = top.map((f) => f.kind);
    expect(new Set(kinds).size).toBeGreaterThanOrEqual(Math.min(3, kinds.length));
  });

  it('stays quiet with too little to go on', () => {
    expect(discover(library().slice(0, 5))).toEqual([]);
  });
});

describe('favouriteScore', () => {
  it('is the rating alone until there is listening history', () => {
    expect(favouriteScore(92, 0, 0)).toBe(92);
  });

  it('lets a heavily played track overtake a slightly better rated one', () => {
    const most = 200;
    expect(favouriteScore(90, 200, most)).toBeGreaterThan(favouriteScore(95, 3, most));
  });

  it('keeps an unrated but much played track in the running', () => {
    expect(favouriteScore(null, 150, 200)).toBeGreaterThan(favouriteScore(70, 0, 200));
  });
});

describe('discover, beyond the obvious', () => {
  it('notices when titles in capitals score higher', () => {
    const facts = library().map((f, i) => (i % 3 === 0 ? { ...f, title: `LOUD ${i}`, score: f.score + 12 } : { ...f, title: `Quiet ${i}` }));
    const caps = discover(facts, { limit: 40 }).find((f) => f.key === 'title:caps');
    expect(caps?.headline).toMatch(/^Songs titled in capitals average \d+, \d+ points above the rest$/);
  });

  it('finds whose music the gut overrates', () => {
    // Considered scores as they are; the quick gut score runs 15 high for artist0 only.
    const facts = library().map((f) => ({
      ...f,
      axes: { production: 8, songwriting: 8, lyrics: 8, performance: 8 },
      gut: f.score + (f.credits[0]!.id === 'artist0' ? 15 : 0) + ((Number(f.id.slice(1)) % 5) - 2),
    }));
    const gut = discover(facts, { limit: 40 }).find((f) => f.key === 'gut:artist:artist0');
    expect(gut?.headline).toBe('Your gut overrates Artist0');
  });
});


describe('playlists from findings', () => {
  it('offers a playlist of a high-scoring group, as a definition the query page accepts', () => {
    const rango = discover(library(), { limit: 30 }).find((f) => f.key === 'credit:production:rango:producer')!;
    const encoded = new URL(rango.playlist!, 'https://x').searchParams.get('d')!;
    const definition = decodeDefinition(encoded);
    expect(definition).toMatchObject({ entity: 'recording', where: { field: 'producer', op: 'eq', value: 'Rango' } });
    expect(definitionSchema.safeParse(definition).success).toBe(true);
  });

  it('offers none for the low end', () => {
    expect(discover(library(), { limit: 30 }).filter((f) => f.tone === 'down').every((f) => !f.playlist)).toBe(true);
  });
});
