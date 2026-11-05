/**
 * Trying a service's key for real, when it is saved or on request, and
 * recording the answer for /manage/connections.
 */

import { credentials, recordCheck, service, type ServiceId } from './connections';
import { identity } from './sources/discogs';
import { checkKey as lastfmKey, userInfo } from './sources/lastfm';
import { listenCount, validateToken } from './sources/listenbrainz';
import { checkKey as setlistKey } from './sources/setlistfm';

const API_GENIUS = 'https://api.genius.com';

/** Says what worked ("Connected as cillian · 48,210 scrobbles"), or throws why not. */
async function attempt(id: ServiceId, c: Record<string, string>): Promise<string> {
  switch (id) {
    case 'lastfm': {
      if (!c.username) {
        await lastfmKey(c.api_key!);
        return 'Key works. Add your username to sync scrobbles.';
      }
      const user = await userInfo(c.api_key!, c.username);
      return `Connected as ${user.name} · ${user.playcount.toLocaleString('en-GB')} scrobbles`;
    }
    case 'listenbrainz': {
      if (c.token) {
        const owner = await validateToken(c.token);
        if (owner.toLowerCase() !== c.username!.toLowerCase()) throw new Error(`That token belongs to ${owner}, not ${c.username}.`);
      }
      const count = await listenCount(c.username!, c.token);
      return `Connected as ${c.username} · ${count.toLocaleString('en-GB')} listens`;
    }
    case 'discogs':
      return `Connected as ${await identity(c.token!)}`;
    case 'setlistfm':
      await setlistKey(c.api_key!);
      return 'Key works';
    case 'genius': {
      const res = await fetch(`${API_GENIUS}/search?q=radiohead`, { headers: { authorization: `Bearer ${c.token}` } });
      if (res.status === 401) throw new Error('Genius did not accept the token.');
      if (!res.ok) throw new Error(`Genius answered ${res.status}.`);
      return 'Token works';
    }
  }
}

export async function checkConnection(id: ServiceId): Promise<{ ok: boolean; detail: string }> {
  const c = await credentials(id);
  if (!c) return { ok: false, detail: `${service(id)!.name} needs its key first.` };
  try {
    const detail = await attempt(id, c);
    await recordCheck(id, true, detail);
    return { ok: true, detail };
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 200) : 'That did not work.';
    await recordCheck(id, false, detail);
    return { ok: false, detail };
  }
}
