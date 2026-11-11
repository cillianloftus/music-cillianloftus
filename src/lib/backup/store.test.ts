import { describe, expect, it } from 'vitest';
import { backupsToPrune, gzipPieces } from './store';

const key = (date: string) => `backups/${date}.json.gz`;

describe('backupsToPrune', () => {
  const today = new Date('2026-11-04T04:00:00Z');
  const days = (n: number) =>
    Array.from({ length: n }, (_, i) => new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10));

  it('keeps the newest 30', () => {
    const keys = days(30).map(key);
    expect(backupsToPrune(keys, today)).toEqual([]);
  });

  it('prunes older dailies but keeps the first of each month for a year', () => {
    const keys = days(120).map(key);
    const pruned = backupsToPrune(keys, today);
    expect(pruned).not.toContain(key('2026-08-01'));
    expect(pruned).toContain(key('2026-08-02'));
    expect(pruned).not.toContain(key(days(1)[0]!));
  });

  it('eventually lets monthly backups go', () => {
    expect(backupsToPrune([...days(30).map(key), key('2025-01-01')], today)).toEqual([key('2025-01-01')]);
  });
});

describe('gzipPieces', () => {
  it('compresses text made a piece at a time into one gzip file', async () => {
    async function* pieces() {
      for (let i = 0; i < 2000; i++) yield `["row ${i}", ${i}],`;
    }
    const gz = await gzipPieces(pieces());
    const text = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    expect(text).toBe(Array.from({ length: 2000 }, (_, i) => `["row ${i}", ${i}],`).join(''));
    expect(gz.byteLength).toBeLessThan(text.length / 2);
  });
});
