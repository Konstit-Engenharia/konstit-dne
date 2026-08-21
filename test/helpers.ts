import type { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { SQLITE_CEP_TABLE_NAME } from '../src/settings.ts';

export function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd: process.cwd(), stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stderr.toString()}`);
  }
}

export function createFixture(directory: string, rows: number) {
  run('bun', ['run', 'benchmarks/create-benchmark-dne.ts', directory, String(rows)]);
}

export function fetchDatabase(databasePath: string, sourcePath: string) {
  run('bun', ['run', 'src/index.ts', 'fetch', databasePath, '--source', sourcePath]);
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
