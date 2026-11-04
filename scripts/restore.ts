/**
 * Restores a backup into an empty, migrated D1 database.
 *
 *   npm run restore -- <backup.json | backup.json.gz> --local [--persist-to <dir>]
 *   npm run restore -- <backup.json | backup.json.gz> --remote
 *
 * Runs directly under Node (type stripping), using only the dependency-free
 * format module, so it works even if the rest of the stack does not.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { backupToSql, summarise, type Backup } from '../src/lib/backup/format.ts';

const DATABASE = 'music-db';

function fail(message: string): never {
  console.error(`\nRestore stopped: ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--persist-to');
const remote = args.includes('--remote');
const local = args.includes('--local');
const persistIndex = args.indexOf('--persist-to');
const persistTo = persistIndex >= 0 ? args[persistIndex + 1] : undefined;

if (!file || remote === local) {
  fail('usage: npm run restore -- <backup.json[.gz]> (--local [--persist-to <dir>] | --remote)');
}

const raw = readFileSync(file);
const text = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
const backup = JSON.parse(text) as Backup;
const sql = backupToSql(backup); // validates the format
const summary = summarise(backup);

// The target's schema must be the backup's, or newer.
const localMigrations = readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort();
const unknown = backup.migrations.filter((m) => !localMigrations.includes(m));
if (unknown.length > 0) fail(`the backup comes from a newer schema (${unknown.join(', ')}). Update the code first.`);
const newer = localMigrations.filter((m) => !backup.migrations.includes(m));
if (backup.migrations.length > 0 && newer.length > 0) {
  console.warn(`Note: migrations newer than the backup will be in place: ${newer.join(', ')}`);
}

const target = [remote ? '--remote' : '--local', ...(persistTo ? ['--persist-to', persistTo] : [])];

/**
 * Runs wrangler through a shell (npx is a .cmd on Windows, which Node will
 * only start via a shell), as one command string with each argument quoted.
 * Arguments come from this script and the user's own paths, never from the
 * backup's contents.
 */
function wrangler(extra: string[], inherit = false) {
  const quote = (arg: string) => (/^[\w./:@=-]+$/.test(arg) ? arg : `"${arg.replaceAll('"', '\\"')}"`);
  const command = ['npx', 'wrangler', 'd1', 'execute', DATABASE, ...target, ...extra].map(quote).join(' ');
  return spawnSync(command, { shell: true, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe' });
}

// Refuse anything but an empty database. The SQL has its own guard too.
const check = wrangler([
  '--json',
  '--command',
  'SELECT (SELECT count(*) FROM rating) + (SELECT count(*) FROM release_group) + (SELECT count(*) FROM artist) AS n',
]);
if (check.status !== 0) fail(`could not read the target database. Has it been migrated?\n${check.stderr}`);
const existing = Number(/"n":\s*(\d+)/.exec(check.stdout)?.[1] ?? NaN);
if (existing !== 0) fail('the target database already holds data. Restores only go into an empty database.');

const dir = mkdtempSync(join(tmpdir(), 'music-restore-'));
const sqlFile = join(dir, 'restore.sql');
writeFileSync(sqlFile, sql);

console.log(
  `Restoring the backup from ${backup.created_at}: ${summary.tables} tables, ${summary.rows} rows, ` +
    `${summary.ratings} ratings, into the ${remote ? 'remote' : 'local'} database…`,
);
const result = wrangler(['--yes', '--file', sqlFile], true);
if (result.status !== 0) fail('wrangler reported an error (above). Nothing after the failing statement was applied.');
console.log('\nRestored.');
