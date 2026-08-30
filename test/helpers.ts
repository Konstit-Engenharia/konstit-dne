import type { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import {
  basename,
  join,
} from 'node:path';
import { SQLITE_CEP_TABLE_NAME } from '../src/settings.ts';

export function run(command: string, args: string[], cwd = process.cwd()) {
  const result = spawnSync(command, args, { cwd, stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stderr.toString()}`);
  }
}

export function createFixture(directory: string, rows: number) {
  run('bun', ['run', 'bench/create-dne.bench.ts', directory, String(rows)]);
}

export function createNestedZipFixture(directory: string, rows: number) {
  const dneDirectory = join(directory, 'dne');
  const innerZip = join(directory, 'eDNE_Basico_12345.zip');
  const outerZip = join(directory, 'eDNE_Basico.zip');

  createFixture(dneDirectory, rows);
  run('zip', ['-qr', innerZip, 'Delimitado'], dneDirectory);
  run('zip', ['-q', outerZip, basename(innerZip)], directory);
  return outerZip;
}

export function fetchDatabase(databasePath: string, sourcePath: string) {
  run('bun', ['run', 'src/index.ts', 'build', '--db', databasePath, '--source', sourcePath]);
}

export function rowCount(db: Database) {
  const statement = db.prepare(`SELECT count(*) AS count FROM ${SQLITE_CEP_TABLE_NAME}`);
  try {
    return (
      statement.get() as {
        count: number;
      }
    ).count;
  } finally {
    statement.finalize();
  }
}

export async function expectRejects(promise: Promise<unknown>) {
  try {
    await promise;
  } catch {
    return;
  }

  throw new Error('Expected promise to reject');
}
