/**
 * The daily backup (ARCHITECTURE.md §10): R2 with rolling retention, plus
 * a commit to a private GitHub repo, which gives version history for free
 * and a copy outside Cloudflare entirely.
 */

import { env } from 'cloudflare:workers';
import { dumpDatabase } from './dump';
import { summarise, type Backup, type BackupSummary } from './format';

export const BACKUP_PREFIX = 'backups/';
const KEEP_DAILY = 30;
const KEEP_MONTHLY_DAYS = 400;

export interface BackupReport {
  key: string;
  bytes: number;
  summary: BackupSummary;
  pruned: string[];
  github: 'committed' | 'not configured';
}

/**
 * JSON with one row per line, so successive commits diff row by row
 * instead of as one enormous changed line.
 */
export function formatForGit(backup: Backup): string {
  const tables = Object.entries(backup.tables)
    .map(([name, dump]) => {
      const rows = dump.rows.map((row) => `      ${JSON.stringify(row)}`).join(',\n');
      return `    ${JSON.stringify(name)}: {\n      "columns": ${JSON.stringify(dump.columns)},\n      "rows": [\n${rows}\n      ]\n    }`;
    })
    .join(',\n');
  const { tables: _tables, ...header } = backup;
  const head = JSON.stringify(header, null, 2).replace(/\n}$/, '');
  return `${head},\n  "tables": {\n${tables}\n  }\n}\n`;
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function commitToGitHub(content: string, date: string): Promise<'committed' | 'not configured'> {
  const token = env.GITHUB_BACKUP_TOKEN;
  const repo = env.GITHUB_BACKUP_REPO;
  if (!token || !repo) return 'not configured';

  const url = `https://api.github.com/repos/${repo}/contents/backup.json`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'music-cillianloftus-backup',
  };

  const existing = await fetch(url, { headers });
  if (!existing.ok && existing.status !== 404) {
    throw new Error(`GitHub backup: reading the repo failed (${existing.status}).`);
  }
  const sha = existing.ok ? ((await existing.json()) as { sha: string }).sha : undefined;

  const response = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Backup ${date}`, content: base64(content), sha }),
  });
  if (!response.ok) throw new Error(`GitHub backup: commit failed (${response.status}).`);
  return 'committed';
}

/**
 * Keeps the newest 30 daily backups and the first of each month for about
 * a year. Keys are backups/YYYY-MM-DD.json.gz, so name order is date order.
 */
export function backupsToPrune(keys: string[], today: Date): string[] {
  const sorted = [...keys].filter((k) => k.startsWith(BACKUP_PREFIX)).sort().reverse();
  const cutoff = new Date(today.getTime() - KEEP_MONTHLY_DAYS * 86_400_000).toISOString().slice(0, 10);
  return sorted.filter((key, i) => {
    if (i < KEEP_DAILY) return false;
    const date = key.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 10);
    const monthly = date.endsWith('-01') && date >= cutoff;
    return !monthly;
  });
}

export async function listBackups(): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.ASSET_STORE.list({ prefix: BACKUP_PREFIX, cursor, include: ['customMetadata'] });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects.sort((a, b) => b.key.localeCompare(a.key));
}

export async function runBackup(): Promise<BackupReport> {
  const backup = await dumpDatabase();
  const summary = summarise(backup);
  const date = backup.created_at.slice(0, 10);
  const key = `${BACKUP_PREFIX}${date}.json.gz`;

  const body = await gzip(JSON.stringify(backup));
  await env.ASSET_STORE.put(key, body, {
    httpMetadata: { contentType: 'application/gzip' },
    customMetadata: {
      created_at: backup.created_at,
      rows: String(summary.rows),
      ratings: String(summary.ratings),
      migration: backup.migrations.at(-1) ?? '',
    },
  });

  const pruned = backupsToPrune((await listBackups()).map((o) => o.key), new Date());
  if (pruned.length > 0) await env.ASSET_STORE.delete(pruned);

  const github = await commitToGitHub(formatForGit(backup), date);
  return { key, bytes: body.byteLength, summary, pruned, github };
}
