import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { closestName, interpret, InterpretError, schemaGuide, snapNames, systemPrompt, type Interpreter, type Message, type Vocabulary } from './interpret';
import { definitionSchema } from './schema';

/** An in-memory KV with the two calls interpret() makes. */
function memoryKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string, type?: string) {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
  };
}

/** A model that replies from a script, recording what it was sent. */
function scripted(...replies: unknown[]) {
  const calls: Message[][] = [];
  const interpreter: Interpreter = {
    async complete(messages) {
      calls.push(messages.map((m) => ({ ...m })));
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
      return typeof reply === 'string' ? reply : JSON.stringify(reply);
    },
  };
  return { interpreter, calls };
}

const vocabulary: Vocabulary = { artists: ['Quadeca', 'Fleetwood Mac', 'Björk', 'Bon Iver'], genres: ['indie pop', 'rock', 'art pop'] };
let kv: ReturnType<typeof memoryKv>;

beforeEach(() => {
  kv = memoryKv();
  (env as { CACHE: unknown }).CACHE = kv;
});

const quadecaTop = { entity: 'recording', where: { field: 'artist', op: 'eq', value: 'Quadeca' }, sort: [{ field: 'quality_score', dir: 'desc' }], limit: 10 };

describe('interpret', () => {
  it('returns a validated definition', async () => {
    const { interpreter } = scripted(quadecaTop);
    const result = await interpret('top 10 quadeca songs', null, { interpreter, vocabulary });
    expect(result.definition).toEqual(definitionSchema.parse(quadecaTop));
    expect(result.cached).toBe(false);
  });

  it('caches by utterance, so asking again does not call the model', async () => {
    const { interpreter, calls } = scripted(quadecaTop);
    await interpret('Top 10 Quadeca songs.', null, { interpreter, vocabulary });
    const again = await interpret('  top 10 quadeca songs ', null, { interpreter, vocabulary });
    expect(again.cached).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('keys refinements on the definition being refined too', async () => {
    const { interpreter, calls } = scripted(quadecaTop, { ...quadecaTop, limit: 30 });
    const first = await interpret('make it thirty', null, { interpreter, vocabulary });
    await interpret('make it thirty', first.definition, { interpreter, vocabulary });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.at(-1)!.content).toContain('Current definition: {"entity":"recording"');
  });

  it('gives an invalid reply its errors and one more try', async () => {
    const bad = { entity: 'recording', where: { field: 'mood', op: 'eq', value: 'sad' } };
    const { interpreter, calls } = scripted(bad, quadecaTop);
    const result = await interpret('sad quadeca songs', null, { interpreter, vocabulary });
    expect(result.definition.limit).toBe(10);
    expect(calls[1]!.at(-1)!.content).toContain('Unknown field "mood"');
  });

  it('fails after two invalid replies, caching nothing', async () => {
    const { interpreter } = scripted('I think you want SELECT * FROM rating; DROP TABLE rating', { entity: 'rating' });
    await expect(interpret('anything', null, { interpreter, vocabulary })).rejects.toBeInstanceOf(InterpretError);
    expect(kv.store.size).toBe(0);
  });

  it('accepts JSON wrapped in prose', async () => {
    const { interpreter } = scripted(`Here you go:\n${JSON.stringify(quadecaTop)}\nEnjoy!`);
    expect((await interpret('top quadeca', null, { interpreter, vocabulary })).definition.limit).toBe(10);
  });

  it('rejects empty and overlong input before calling the model', async () => {
    const { interpreter, calls } = scripted(quadecaTop);
    await expect(interpret('   ', null, { interpreter, vocabulary })).rejects.toBeInstanceOf(InterpretError);
    await expect(interpret('x'.repeat(501), null, { interpreter, vocabulary })).rejects.toBeInstanceOf(InterpretError);
    expect(calls).toHaveLength(0);
  });

  it('snaps a misheard artist to the library spelling and says so', async () => {
    const { interpreter } = scripted({ ...quadecaTop, where: { field: 'artist', op: 'eq', value: 'Kwadeca' } });
    const result = await interpret('top 10 kwadeca songs', null, { interpreter, vocabulary });
    expect(result.definition.where).toEqual({ field: 'artist', op: 'eq', value: 'Quadeca' });
    expect(result.snaps).toEqual([{ heard: 'Kwadeca', name: 'Quadeca' }]);
  });
});

describe('closestName', () => {
  it('matches ignoring case, accents and a leading "the"', () => {
    expect(closestName('bjork', vocabulary.artists)).toBe('Björk');
    expect(closestName('fleetwood mac', vocabulary.artists)).toBe('Fleetwood Mac');
  });

  it('corrects small slips but leaves unknown names alone', () => {
    expect(closestName('Bon Ivar', vocabulary.artists)).toBe('Bon Iver');
    expect(closestName('Radiohead', vocabulary.artists)).toBeNull();
  });
});

describe('snapNames', () => {
  it('fixes genres and lists, and leaves contains and other fields alone', () => {
    const definition = definitionSchema.parse({
      entity: 'release_group',
      where: {
        and: [
          { field: 'genre', op: 'in_tree', value: 'indie-pop' },
          { field: 'artist', op: 'in', value: ['quadeca', 'Bon Ivar'] },
          { field: 'artist', op: 'contains', value: 'bon' },
          { field: 'title', op: 'eq', value: 'Rumors' },
        ],
      },
    });
    const { definition: snapped, snaps } = snapNames(definition, vocabulary);
    expect(snapped.where).toEqual({
      and: [
        { field: 'genre', op: 'in_tree', value: 'indie pop' },
        { field: 'artist', op: 'in', value: ['Quadeca', 'Bon Iver'] },
        { field: 'artist', op: 'contains', value: 'bon' },
        { field: 'title', op: 'eq', value: 'Rumors' },
      ],
    });
    expect(snaps).toHaveLength(3);
  });
});

describe('prompt', () => {
  it('lists every field the validator accepts, and the library names', () => {
    const guide = schemaGuide();
    expect(guide).toContain('quality_score: number, sortable');
    expect(guide).toContain('group by: artist');
    const prompt = systemPrompt(vocabulary, '2026-11-04');
    expect(prompt).toContain('Quadeca; Fleetwood Mac');
    expect(prompt).toContain('Today is 2026-11-04');
  });
});
