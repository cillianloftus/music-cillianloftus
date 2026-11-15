import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('search entries on a merge', () => {
  it('are found by their words, so a merge never reads the whole index', async () => {
    const { dropFromSearch } = await import('./merge');
    const { migratedDb } = await import('../test/db');
    const { d1 } = await import('../test/d1');
    const db = migratedDb();
    (env as { DB: D1Database }).DB = d1(db);
    db.exec(`INSERT INTO search_index (name, kind, entity_id) VALUES ('Dont Stop', 'recording', 'r1'), ('Dont Stop', 'recording', 'r2'), ('Other', 'recording', 'r3')`);
    await dropFromSearch('recording', 'r1', 'Don’t Stop').run();
    await dropFromSearch('recording', 'r3', '!!!').run();
    expect(db.prepare(`SELECT entity_id FROM search_index ORDER BY entity_id`).all()).toEqual([{ entity_id: 'r2' }]);
  });
});
