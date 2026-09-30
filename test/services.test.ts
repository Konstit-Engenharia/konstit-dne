import { Database } from 'bun:sqlite';
import {
  afterAll,
  afterEach,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BINARY_DATABASE_MAGIC } from '../src/binary-db-format.ts';
import {
  installCronSchedule,
  removeCronSchedule,
  showCronSchedule,
} from '../src/cron-service.ts';
import {
  databasePath,
  hasTable,
  inspectDatabase,
  memoryDatabaseInspection,
  openReadyDatabase,
  readDatabaseMetadata,
} from '../src/database-service.ts';
import {
  hasTable as hasSqliteTable,
  readDatabaseMetadata as readSqliteMetadata,
} from '../src/db.ts';
import {
  acquireFetchLock,
  fetchLockPath,
} from '../src/fetch-lock.ts';
import { captureRejection } from './assertions.ts';

const workDir = mkdtempSync(join(tmpdir(), 'dne-services-test-'));
const originalCron = Bun.cron;
const originalStateHome = Bun.env['XDG_STATE_HOME'];

afterEach(() => {
  setCron(originalCron);
  if (originalStateHome === undefined) {
    delete Bun.env['XDG_STATE_HOME'];
  } else {
    Bun.env['XDG_STATE_HOME'] = originalStateHome;
  }
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('database service', () => {
  test('reads metadata and table presence without creating missing databases', async () => {
    const missing = join(workDir, 'missing-metadata.db');
    expect(await readDatabaseMetadata(missing)).toBeUndefined();
    expect(await readSqliteMetadata(missing)).toBeUndefined();
    expect(await hasTable(missing, 'dne')).toBe(false);
    expect(await hasSqliteTable(missing, 'dne')).toBe(false);
    expect(await hasTable(':memory:', 'dne')).toBe(false);
    expect(databasePath(':memory:')).toBe(':memory:');
    expect(existsSync(missing)).toBe(false);
    const path = join(workDir, 'metadata.db');
    const db = new Database(path);
    db.run('CREATE TABLE dne (cep TEXT)');
    expect(await readDatabaseMetadata(path)).toBeUndefined();
    expect(await hasTable(path, 'dne')).toBe(true);
    expect(await hasTable(path, 'absent')).toBe(false);
    db.run('CREATE TABLE edne_metadata (key TEXT, value TEXT)');
    db.run('INSERT INTO edne_metadata VALUES (\'source_kind\', \'local\')');
    db.close();
    expect(await readDatabaseMetadata(path)).toEqual({ source_kind: 'local' });
  });

  test('distinguishes missing tables, invalid SQLite files, and truncated binary files', async () => {
    const path = join(workDir, 'no-dne.db');
    new Database(path).close();
    expect(await captureRejection(openReadyDatabase(path))).toMatchObject({ code: 'database-not-ready' });
    const broken = join(workDir, 'broken.db');
    writeFileSync(broken, 'not a database');
    expect(await inspectDatabase(broken)).toMatchObject({ exists: true, ready: false, error: expect.any(String) });
    const truncated = join(workDir, 'truncated.bin');
    writeFileSync(truncated, BINARY_DATABASE_MAGIC);
    expect(await captureRejection(openReadyDatabase(truncated))).toMatchObject({ code: 'database-invalid' });
  });

  test('resolves, inspects, and opens ready databases', async () => {
    const path = join(workDir, 'service.db');
    const db = new Database(path);
    db.run('CREATE TABLE dne (cep TEXT PRIMARY KEY) WITHOUT ROWID');
    db.run('INSERT INTO dne VALUES (\'01001000\')');
    db.close();

    expect(databasePath(path)).toBe(path);
    expect(databasePath('sqlite:///relative.db')).toBe(join(process.cwd(), 'relative.db'));
    expect(await inspectDatabase(path)).toMatchObject({
      exists: true,
      path,
      ready: true,
      row_count: 1,
    });

    const reader = await openReadyDatabase(path);
    try {
      expect(reader.rowCount('dne')).toBe(1);
    } finally {
      reader.close();
    }
  });

  test('reports missing and in-memory databases without creating files', async () => {
    const path = join(workDir, 'missing.db');
    expect(await inspectDatabase(path)).toMatchObject({ exists: false, ready: false });
    expect(memoryDatabaseInspection(7)).toMatchObject({ path: ':memory:', row_count: 7 });
    expect(openReadyDatabase(path)).rejects.toMatchObject({ code: 'database-not-found' });
    expect(existsSync(path)).toBe(false);
  });
});

describe('cron service', () => {
  test('installs, preserves the source, reports, and removes a schedule', async () => {
    const calls: { action: string; title: string; }[] = [];
    setCron(fakeCron(calls));
    Bun.env['XDG_STATE_HOME'] = join(workDir, 'state');
    const database = join(workDir, 'scheduled.db');
    const source = join(workDir, 'source.zip');

    const preview = await installCronSchedule({
      database,
      dryRun: true,
      expression: '0 0 * * 5',
      packageVersion: '1.2.3',
      source,
    });
    expect(preview).toMatchObject({ source, status: 'preview' });

    const installed = await installCronSchedule({
      database,
      dryRun: false,
      expression: '0 0 * * 5',
      packageVersion: '1.2.3',
      source,
    });
    expect(installed.status).toBe('installed');
    expect(existsSync(installed.runner)).toBe(true);
    expect(showCronSchedule(database)).toMatchObject({ installed: true, source });

    const updated = await installCronSchedule({
      database,
      dryRun: false,
      expression: '30 6 * * 5',
      packageVersion: '1.2.3',
    });
    expect(updated).toMatchObject({ source, status: 'updated' });

    expect(await removeCronSchedule(database)).toMatchObject({ removed: true });
    expect(showCronSchedule(database).installed).toBe(false);
    expect(calls.map((call) => call.action)).toEqual(['install', 'install', 'remove']);
  });
});

describe('fetch lock service', () => {
  test('acquires and releases the lock for a database path', async () => {
    const target = join(workDir, 'locked.db');
    const messages: string[] = [];
    const progress = Object.assign((message: string) => messages.push(message), {
      finish() {},
    });
    const lock = await acquireFetchLock(target, progress);
    expect(existsSync(fetchLockPath(target))).toBe(true);
    expect(messages).toEqual([]);
    lock.release();
    expect(existsSync(fetchLockPath(target))).toBe(false);
  });

  test('recovers a lock owned by a process that does not exist', async () => {
    const target = join(workDir, 'stale.db');
    const path = fetchLockPath(target);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: 2_147_483_647, token: 'stale' }));
    const progress = Object.assign((_message: string) => {}, { finish() {} });
    const lock = await acquireFetchLock(target, progress);
    lock.release();
    expect(existsSync(path)).toBe(false);
  });
});

function fakeCron(calls: { action: string; title: string; }[]) {
  const cron = async (_path: string, _schedule: string, title: string) => {
    calls.push({ action: 'install', title });
  };
  cron.parse = originalCron.parse.bind(originalCron);
  cron.remove = async (title: string) => {
    calls.push({ action: 'remove', title });
  };
  return cron as unknown as typeof Bun.cron;
}

function setCron(cron: typeof Bun.cron) {
  (Bun as unknown as { cron: typeof Bun.cron; }).cron = cron;
}
