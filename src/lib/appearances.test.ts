import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { d1 } from '../test/d1';
import { migratedDb, seedLibrary } from '../test/db';
import { trackAppearances } from './pages';

beforeEach(() => {
  const db = migratedDb();
  seedLibrary(db);
  (env as { DB: D1Database }).DB = d1(db);
  db.exec(`UPDATE release SET note = 'The Extended Cut' WHERE id = 'r-a-deluxe'`);
});

describe('where a song appears', () => {
  it('names the edition when it is on another edition only', async () => {
    // a4 is on Album A's deluxe edition alone, at 4.
    const [on] = await trackAppearances('a4', 'u-owner');
    expect(on).toMatchObject({ standard: false, edition: { id: 'r-a-deluxe', name: 'The Extended Cut', position: 4 } });
  });

  it('says nothing more for a song on the standard edition', async () => {
    const [on] = await trackAppearances('a1', 'u-owner');
    expect(on).toMatchObject({ standard: true, edition: null });
  });
});
