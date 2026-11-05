/**
 * Restores a backup into an empty, migrated D1 database.
 *
 *   npm run restore -- <backup.json | backup.json.gz> --local [--persist-to <dir>]
 *   npm run restore -- <backup.json | backup.json.gz> --remote [--resume]
 *
 * A remote restore goes in parts of about 1.5MB, each its own transaction,
 * each retried if the connection drops, so one blip near the end of a large
 * library does not throw the whole upload away. A part that landed before
 * its answer was lost is harmless to send again. If it still gives up,
 * --resume carries on into the partly restored database.
 *
 * Runs directly under Node (type stripping), using only the dependency-free
 * format module, so it works even if the rest of the stack does not.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { backupToSql, backupToSqlParts, readKeys, summarise, type Backup } from '../src/lib/backup/format.ts';

const DATABASE = 'music-db';

function fail(message: string): never {
  console.error(`\nRestore stopped: ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--persist-to');
const remote = args.includes('--remote');
const local = args.includes('--local');
const resume = args.includes('--resume');
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
if (existing !== 0 && !resume) fail('the target database already holds data. Restores only go into an empty database.');
if (resume && !remote) fail('--resume is for a remote restore that stopped partway.');

const dir = mkdtempSync(join(tmpdir(), 'music-restore-'));

console.log(
  `Restoring the backup from ${backup.created_at}: ${summary.tables} tables, ${summary.rows} rows, ` +
    `${summary.ratings} ratings, into the ${remote ? 'remote' : 'local'} database…`,
);

if (!remote) {
  const sqlFile = join(dir, 'restore.sql');
  writeFileSync(sqlFile, sql);
  const result = wrangler(['--yes', '--file', sqlFile], true);
  if (result.status !== 0) fail('wrangler reported an error (above). Nothing after the failing statement was applied.');
  console.log('\nRestored.');
  process.exit(0);
}

/** The schema's keys, read from the migrations in a scratch in-memory database. */
function schemaKeys() {
  const db = new DatabaseSync(':memory:');
  for (const m of localMigrations) db.exec(readFileSync(join('migrations', m), 'utf8'));
  return readKeys((sql, ...params) => db.prepare(sql).all(...params));
}

const parts = backupToSqlParts(backup, schemaKeys());
// When resuming, the emptiness guard (part 1) would refuse; everything after it is safe to resend.
const first = resume ? 1 : 0;
const waits = [5, 15, 30, 60, 120];
for (let i = first; i < parts.length; i++) {
  const partFile = join(dir, `part-${i + 1}.sql`);
  writeFileSync(partFile, parts[i]!);
  const label = `Part ${i + 1} of ${parts.length} (${(parts[i]!.length / 1e6).toFixed(1)}MB)`;
  for (let attempt = 0; ; attempt++) {
    process.stdout.write(`${label}${attempt ? `, try ${attempt + 1}` : ''}… `);
    const result = wrangler(['--yes', '--file', partFile]);
    if (result.status === 0) {
      console.log('done');
      break;
    }
    const why = `${result.stdout}\n${result.stderr}`;
    // A refusal from the database will not change on a retry; only the connection might.
    const connection = /fetch failed|connectivity|ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(why);
    if (!connection || attempt >= waits.length) {
      console.log('failed');
      console.error(why.trim());
      fail(
        `part ${i + 1} did not go in. Parts before it are in place. Fix the cause, then run the same command with --resume.`,
      );
    }
    console.log(`connection dropped, retrying in ${waits[attempt]}s`);
    spawnSync(process.execPath, ['-e', `setTimeout(() => {}, ${waits[attempt]! * 1000})`]);
  }
}
console.log('\nRestored.');
