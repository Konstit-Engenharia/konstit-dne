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
import {
  installCronSchedule,
  removeCronSchedule,
  showCronSchedule,
} from '../src/cron-service.ts';
import {
  databasePath,
  inspectDatabase,
  memoryDatabaseInspection,
  openReadyDatabase,
} from '../src/database-service.ts';
import {
  acquireFetchLock,
  fetchLockPath,
} from '../src/fetch-lock.ts';

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
