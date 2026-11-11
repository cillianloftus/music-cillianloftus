/**
 * The daily backup (ARCHITECTURE.md §10): R2 with rolling retention, plus
 * a commit to a private GitHub repo, which gives version history for free
 * and a copy outside Cloudflare entirely.
 */

import { env } from 'cloudflare:workers';
import { backupText } from './dump';
import type { BackupSummary } from './format';

export const BACKUP_PREFIX = 'backups/';
const KEEP_DAILY = 30;
const KEEP_MONTHLY_DAYS = 400;

export interface BackupReport {
  key: string;
  bytes: number;
  summary: BackupSummary;
  pruned: string[];
  github: 'committed' | 'not configured' | 'not this week';
}

/** Gzips text as it is made, holding only the compressed bytes. */
export async function gzipPieces(pieces: AsyncIterable<string>): Promise<ArrayBuffer> {
  const gzip = new CompressionStream('gzip');
  // Read while writing, or the stream fills and the writes wait for ever.
  const compressed = new Response(gzip.readable).arrayBuffer();
  const writer = gzip.writable.getWriter();
  const encoder = new TextEncoder();
  for await (const piece of pieces) await writer.write(encoder.encode(piece));
  await writer.close();
  return compressed;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * The copy outside Cloudflare: the gzipped backup, committed once a week
 * (Sundays) as backup.json.gz, so the repo's history holds a weekly
 * series. Uncompressed, row-per-line JSON would diff more neatly, but at
 * this size it is past what one request to GitHub's contents API can
 * carry, and past a Worker's memory to build.
 */
async function commitToGitHub(gz: ArrayBuffer, date: string): Promise<'committed' | 'not configured'> {
  const token = env.GITHUB_BACKUP_TOKEN;
  const repo = env.GITHUB_BACKUP_REPO;
  if (!token || !repo) return 'not configured';

  const url = `https://api.github.com/repos/${repo}/contents/backup.json.gz`;
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
    body: JSON.stringify({ message: `Backup ${date}`, content: base64(new Uint8Array(gz)), sha }),
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

export async function runBackup(now = new Date()): Promise<BackupReport> {
  const { created_at, migrations, summary, pieces } = await backupText();
  const body = await gzipPieces(pieces);
  const date = created_at.slice(0, 10);
  const key = `${BACKUP_PREFIX}${date}.json.gz`;
  await env.ASSET_STORE.put(key, body, {
    httpMetadata: { contentType: 'application/gzip' },
    customMetadata: {
      created_at,
      rows: String(summary.rows),
      ratings: String(summary.ratings),
      migration: migrations.at(-1) ?? '',
    },
  });

  const pruned = backupsToPrune((await listBackups()).map((o) => o.key), now);
  if (pruned.length > 0) await env.ASSET_STORE.delete(pruned);

  const github = now.getUTCDay() === 0 ? await commitToGitHub(body, date) : 'not this week';
  return { key, bytes: body.byteLength, summary, pruned, github };
}
