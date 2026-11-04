import { describe, expect, it } from 'vitest';
import { BACKUP_FORMAT, BACKUP_VERSION, type Backup } from './format';
import { backupsToPrune, formatForGit } from './store';

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

describe('formatForGit', () => {
  const backup: Backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    created_at: '2026-11-04T04:00:00.000Z',
    migrations: ['0001_initial_schema.sql'],
    restore_order: ['artist'],
    tables: { artist: { columns: ['id', 'name'], rows: [['a', 'One'], ['b', 'Two "quoted"']] } },
  };

  it('is valid JSON that parses back to the same backup', () => {
    expect(JSON.parse(formatForGit(backup))).toEqual(backup);
  });

  it('puts each row on its own line', () => {
    const lines = formatForGit(backup).split('\n');
    expect(lines.filter((l) => l.trim().startsWith('["'))).toHaveLength(2);
  });
});
