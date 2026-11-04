/**
 * Natural language to definition (ARCHITECTURE.md §4, "The pipeline").
 *
 *   utterance → model, prompted with the field registry and the library's
 *   names → JSON → definitionSchema (the security boundary) → names snapped
 *   to the library → definition.
 *
 * The model only ever produces a definition; it has no vocabulary for SQL
 * and its output is untrusted. A response that fails validation gets one
 * repair attempt with the errors shown to it, then the request fails.
 *
 * Interpretations are cached in KV by utterance (and, when refining, the
 * definition being refined). What a sentence means does not change when
 * ratings do.
 */

import { env } from 'cloudflare:workers';
import { normaliseName } from '../text';
import { ENTITIES, OPS_BY_TYPE, type Entity } from './fields';
import { LIMIT_MAX, LIMIT_PER_GROUP_MAX, definitionSchema, describeIssues, type Definition, type Where } from './schema';
import { artistNames, genreNames } from './vocabulary';

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** The one thing a model has to do. Swapping providers touches only an implementation of this. */
export interface Interpreter {
  complete(messages: Message[]): Promise<string>;
}

export const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export const workersAi: Interpreter = {
  async complete(messages) {
    const result = (await env.AI.run(MODEL, {
      messages,
      response_format: { type: 'json_object' },
      max_tokens: 800,
      temperature: 0,
    } as never)) as { response?: unknown };
    const response = result.response;
    return typeof response === 'string' ? response : JSON.stringify(response ?? null);
  },
};

export interface Vocabulary {
  artists: string[];
  genres: string[];
}

export async function libraryVocabulary(): Promise<Vocabulary> {
  const [artists, genres] = await Promise.all([artistNames(), genreNames()]);
  return { artists, genres };
}

/** The registry, as the model reads it. Generated, so it can never drift from what validates. */
export function schemaGuide(): string {
  const lines: string[] = [];
  for (const [entity, spec] of Object.entries(ENTITIES) as [Entity, (typeof ENTITIES)[Entity]][]) {
    lines.push(`entity "${entity}" (${spec.label}):`);
    for (const [name, field] of Object.entries(spec.fields)) {
      const values = field.values ? ` values: ${field.values.join('|')}` : '';
      const sort = field.sortable && field.sql ? ', sortable' : '';
      lines.push(`  ${name}: ${field.type}${sort}; ops: ${OPS_BY_TYPE[field.type].join(',')}${values}${field.description ? ` (${field.description})` : ''}`);
    }
    const groups = Object.keys(spec.groups);
    if (groups.length) lines.push(`  group by: ${groups.join(', ')}`);
  }
  return lines.join('\n');
}

export function systemPrompt(vocabulary: Vocabulary, today: string): string {
  return `You turn a request about a personal music library into one JSON query definition. Reply with the JSON object only.

Shape:
{"entity": "recording"|"release_group"|"artist",
 "where"?: Condition | {"and": [Where...]} | {"or": [Where...]},
 "sort"?: [{"field": string, "dir": "asc"|"desc"}],
 "group"?: {"by": string, "limit_per_group": 1-${LIMIT_PER_GROUP_MAX}, "sort"?: [...]},
 "collapse_by_work"?: boolean,
 "limit"?: 1-${LIMIT_MAX}}
Condition: {"field": string, "op": string, "value"?: ...}. "between" takes [low, high]; "in"/"not_in" take a list; is_null/is_not_null take no value.

Fields:
${schemaGuide()}

Rules:
- "recording" means tracks or songs, "release_group" means albums or records.
- Scores: quality_score is 0-100 (how well made); personal_score adds impact, 0-110 ("favourite", "love", "means the most").
  "best" or "top" without more means sort by quality_score desc. "rated above 80" means quality_score gt 80.
- "top 20" sets limit 20. With no number, leave limit out.
- "top 5 tracks from each of my top 10 artists" uses group {"by": "artist", "limit_per_group": 5}.
- Dates are "YYYY", "YYYY-MM" or "YYYY-MM-DD". "the 90s" is between ["1990", "1999"]. "since 2015" is gte "2015". Today is ${today}.
- For a genre use op "in_tree" so subgenres count.
- artist, producer, writer, featured, remixer, engineer, performer take artist names.
- Set collapse_by_work false only when asked for versions, remixes or covers of songs.
- Use only names below for artists and genres, choosing the closest when the request misspells one (it may be a voice transcript).
- When a current definition is given and the request amends it ("make it thirty", "only albums before 2015", "drop the genre"), change only that and keep everything else. When the request is plainly a new question, answer it from scratch.

Artists in the library: ${vocabulary.artists.join('; ') || '(none)'}
Genres in the library: ${vocabulary.genres.join('; ') || '(none)'}`;
}

/** Edit distance, for snapping a misheard name to the closest one in the library. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/**
 * The library name a value most likely means, or null when nothing is
 * close. Exact (after normalising) wins; otherwise the nearest within
 * roughly a third of the name's length.
 */
export function closestName(value: string, names: string[]): string | null {
  const target = normaliseName(value);
  if (!target) return null;
  let best: { name: string; d: number } | null = null;
  for (const name of names) {
    const n = normaliseName(name);
    if (n === target) return name;
    const d = distance(target, n);
    if (d <= Math.max(1, Math.floor(Math.max(n.length, target.length) / 3)) && (!best || d < best.d)) best = { name, d };
  }
  return best?.name ?? null;
}

export interface Snap {
  heard: string;
  name: string;
}

/** Replaces artist and genre values with the library's own spelling. */
export function snapNames(definition: Definition, vocabulary: Vocabulary): { definition: Definition; snaps: Snap[] } {
  const snaps: Snap[] = [];
  const fields = ENTITIES[definition.entity].fields;
  const fix = (value: unknown, names: string[]): unknown => {
    if (typeof value !== 'string') return value;
    const name = closestName(value, names);
    if (!name || name === value) return value;
    snaps.push({ heard: value, name });
    return name;
  };
  const walk = (node: Where): Where => {
    if ('and' in node) return { and: node.and.map(walk) };
    if ('or' in node) return { or: node.or.map(walk) };
    const type = fields[node.field]?.type;
    const names = type === 'credit' ? vocabulary.artists : type === 'genre' ? vocabulary.genres : null;
    if (!names || node.op === 'contains') return node;
    const value = Array.isArray(node.value) ? node.value.map((v) => fix(v, names)) : fix(node.value, names);
    return { ...node, value };
  };
  return { definition: definition.where ? { ...definition, where: walk(definition.where) } : definition, snaps };
}

export class InterpretError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

export interface Interpretation {
  definition: Definition;
  snaps: Snap[];
  cached: boolean;
}

export const normaliseUtterance = (text: string) => text.trim().toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');

async function cacheKey(utterance: string, current: Definition | null): Promise<string> {
  const data = new TextEncoder().encode(`${normaliseUtterance(utterance)}\n${current ? JSON.stringify(current) : ''}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return `nl:v1:${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const CACHE_TTL = 60 * 60 * 24 * 30;
export const UTTERANCE_MAX = 500;

/** Pulls the first JSON object out of a reply, in case a model wraps it in prose. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    return undefined;
  }
}

export async function interpret(
  utterance: string,
  current: Definition | null,
  options: { interpreter?: Interpreter; vocabulary?: Vocabulary; today?: string } = {},
): Promise<Interpretation> {
  const text = utterance.trim();
  if (!text) throw new InterpretError('Say or type what you want to hear.');
  if (text.length > UTTERANCE_MAX) throw new InterpretError(`Keep it under ${UTTERANCE_MAX} characters.`);

  const key = await cacheKey(text, current);
  const hit = await env.CACHE.get<{ definition: unknown; snaps: Snap[] }>(key, 'json');
  if (hit) {
    // Re-validated: the registry may have changed since it was cached.
    const parsed = definitionSchema.safeParse(hit.definition);
    if (parsed.success) return { definition: parsed.data, snaps: hit.snaps, cached: true };
  }

  const interpreter = options.interpreter ?? workersAi;
  const vocabulary = options.vocabulary ?? (await libraryVocabulary());
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const messages: Message[] = [
    { role: 'system', content: systemPrompt(vocabulary, today) },
    { role: 'user', content: current ? `Current definition: ${JSON.stringify(current)}\nRequest: ${text}` : text },
  ];

  let errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await interpreter.complete(messages);
    const candidate = parseJson(reply);
    const parsed = definitionSchema.safeParse(candidate);
    if (parsed.success) {
      const result = snapNames(parsed.data, vocabulary);
      await env.CACHE.put(key, JSON.stringify(result), { expirationTtl: CACHE_TTL });
      return { ...result, cached: false };
    }
    errors = candidate === undefined ? ['The reply was not JSON.'] : describeIssues(parsed.error);
    messages.push(
      { role: 'assistant', content: reply },
      { role: 'user', content: `That is not valid:\n${errors.join('\n')}\nReply with the corrected JSON object only.` },
    );
  }
  throw new InterpretError('That could not be turned into a query. Try rephrasing, or build it with the filters below.', errors);
}
