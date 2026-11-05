/**
 * Outside services that need a key: what each one gives, where to get the
 * key, and whether it works. A key can be a Worker secret (wrangler secret
 * put, or .dev.vars locally) or pasted on /manage/connections; a secret wins
 * when both exist. Everything that uses a service asks credentials() first
 * and quietly does nothing without them, so a service can be wired in long
 * before its key is.
 */

import { env } from 'cloudflare:workers';

export type ServiceId = 'lastfm' | 'listenbrainz' | 'discogs' | 'setlistfm' | 'genius';

export interface Field {
  key: string;
  label: string;
  /** Shown masked, and never sent back to the page in full. */
  secret: boolean;
  /** The Worker secret or var that supplies it instead. */
  env: string;
  /** Not needed for the service to work. */
  optional?: boolean;
  /** A quick check before saving, to catch a paste of the wrong thing. */
  pattern?: RegExp;
  hint?: string;
}

export interface Service {
  id: ServiceId;
  name: string;
  /** What having it adds, in a line. */
  gives: string;
  /** Where the key comes from. */
  keyUrl: string;
  steps: string;
  fields: Field[];
}

export const SERVICES: Service[] = [
  {
    id: 'lastfm',
    name: 'Last.fm',
    gives: 'Your scrobbles as listening history, plus listener counts, similar artists and tags on artist pages.',
    keyUrl: 'https://www.last.fm/api/account/create',
    steps: 'Create an API account (any name; the callback URL can stay empty) and copy the API key. The username is your Last.fm profile name.',
    fields: [
      { key: 'api_key', label: 'API key', secret: true, env: 'LASTFM_API_KEY', pattern: /^[0-9a-f]{32}$/i, hint: '32 letters and digits' },
      { key: 'username', label: 'Username', secret: false, env: 'LASTFM_USERNAME', optional: true, hint: 'Needed for scrobbles' },
    ],
  },
  {
    id: 'listenbrainz',
    name: 'ListenBrainz',
    gives: 'Your listens as listening history. Open and free, and it matches by MusicBrainz id.',
    keyUrl: 'https://listenbrainz.org/settings/',
    steps: 'Your username is enough for public listens. The user token (on the settings page) is only needed if your listens are private.',
    fields: [
      { key: 'username', label: 'Username', secret: false, env: 'LISTENBRAINZ_USERNAME' },
      { key: 'token', label: 'User token', secret: true, env: 'LISTENBRAINZ_TOKEN', optional: true, pattern: /^[0-9a-f-]{36}$/i },
    ],
  },
  {
    id: 'discogs',
    name: 'Discogs',
    gives: 'Labels, catalogue numbers, countries and formats for physical releases MusicBrainz is thin on.',
    keyUrl: 'https://www.discogs.com/settings/developers',
    steps: 'Under Developers, choose Generate new token and copy it.',
    fields: [{ key: 'token', label: 'Personal access token', secret: true, env: 'DISCOGS_TOKEN', pattern: /^[A-Za-z0-9]{20,64}$/ }],
  },
  {
    id: 'setlistfm',
    name: 'setlist.fm',
    gives: 'Recent shows and the songs an artist plays most live, on artist pages.',
    keyUrl: 'https://www.setlist.fm/settings/api',
    steps: 'Apply for an API key (non-commercial, personal use); it arrives straight away.',
    fields: [{ key: 'api_key', label: 'API key', secret: true, env: 'SETLISTFM_API_KEY', pattern: /^[A-Za-z0-9-]{20,64}$/ }],
  },
  {
    id: 'genius',
    name: 'Genius',
    gives: 'Writer and producer credits MusicBrainz lacks, and links to lyrics.',
    keyUrl: 'https://genius.com/api-clients',
    steps: 'Create an API client (any app website URL), then Generate Access Token and copy it.',
    fields: [{ key: 'token', label: 'Client access token', secret: true, env: 'GENIUS_ACCESS_TOKEN', pattern: /^[A-Za-z0-9_-]{30,100}$/ }],
  },
];

export const service = (id: string): Service | undefined => SERVICES.find((s) => s.id === id);

const fromEnv = (name: string): string | null => {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

/** The values a service has, and where each came from. */
export async function stored(id: ServiceId): Promise<Record<string, { value: string; from: 'secret' | 'pasted' }>> {
  const def = service(id)!;
  const { results } = await env.DB.prepare('SELECT field, value FROM connection_secret WHERE service = ?')
    .bind(id)
    .all<{ field: string; value: string }>();
  const pasted = new Map(results.map((r) => [r.field, r.value]));
  const out: Record<string, { value: string; from: 'secret' | 'pasted' }> = {};
  for (const field of def.fields) {
    const secret = fromEnv(field.env);
    if (secret) out[field.key] = { value: secret, from: 'secret' };
    else if (pasted.get(field.key)) out[field.key] = { value: pasted.get(field.key)!, from: 'pasted' };
  }
  return out;
}

/** A service's values when every required one is there; otherwise null, and callers skip it. */
export async function credentials(id: ServiceId): Promise<Record<string, string> | null> {
  const def = service(id)!;
  const values = await stored(id).catch(() => ({}) as Awaited<ReturnType<typeof stored>>);
  if (def.fields.some((f) => !f.optional && !values[f.key])) return null;
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.value]));
}

/** Saves pasted values; an empty one leaves what was there. Returns problems, by field. */
export async function saveCredentials(id: ServiceId, input: Record<string, string>): Promise<Record<string, string>> {
  const def = service(id)!;
  const problems: Record<string, string> = {};
  const statements: D1PreparedStatement[] = [];
  for (const field of def.fields) {
    const value = (input[field.key] ?? '').trim();
    if (!value) continue;
    if (field.pattern && !field.pattern.test(value)) {
      problems[field.key] = `That doesn’t look like a ${def.name} ${field.label.toLowerCase()}${field.hint ? ` (${field.hint})` : ''}.`;
      continue;
    }
    statements.push(
      env.DB.prepare(
        `INSERT INTO connection_secret (service, field, value) VALUES (?, ?, ?)
         ON CONFLICT (service, field) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).bind(id, field.key, value),
    );
  }
  if (Object.keys(problems).length === 0 && statements.length) await env.DB.batch(statements);
  return problems;
}

/** Forgets pasted values (a Worker secret stays; remove it with wrangler). */
export async function forget(id: ServiceId): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM connection_secret WHERE service = ?').bind(id),
    env.DB.prepare('DELETE FROM connection_state WHERE service = ?').bind(id),
  ]);
}

export interface State {
  status: 'ok' | 'failed';
  detail: string | null;
  checked_at: string;
  cursor: string | null;
  synced_at: string | null;
}

export async function states(): Promise<Map<string, State>> {
  const { results } = await env.DB.prepare('SELECT * FROM connection_state').all<State & { service: string }>();
  return new Map(results.map((r) => [r.service, r]));
}

export async function stateOf(id: ServiceId): Promise<State | null> {
  return env.DB.prepare('SELECT * FROM connection_state WHERE service = ?').bind(id).first<State>();
}

export async function recordCheck(id: ServiceId, ok: boolean, detail: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO connection_state (service, status, detail) VALUES (?, ?, ?)
     ON CONFLICT (service) DO UPDATE SET status = excluded.status, detail = excluded.detail, checked_at = excluded.checked_at`,
  )
    .bind(id, ok ? 'ok' : 'failed', detail)
    .run();
}

export async function recordSync(id: ServiceId, cursor: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO connection_state (service, status, cursor, synced_at) VALUES (?, 'ok', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (service) DO UPDATE SET cursor = excluded.cursor, synced_at = excluded.synced_at`,
  )
    .bind(id, cursor)
    .run();
}

/** Shows enough of a key to recognise it: the last four characters. */
export function mask(value: string): string {
  return value.length <= 6 ? '••••' : `••••${value.slice(-4)}`;
}

/** How many services have no key yet: the Manage page says so. */
export async function waitingCount(): Promise<number> {
  let n = 0;
  for (const s of SERVICES) if (!(await credentials(s.id))) n += 1;
  return n;
}
