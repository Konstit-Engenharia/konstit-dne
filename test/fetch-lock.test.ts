import { Database } from 'bun:sqlite';
import {
  afterAll,
  afterEach,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  join,
} from 'node:path';
import {
  acquireFetchLock,
  fetchLockPath,
} from '../src/fetch-lock.ts';
import { captureRejection } from './assertions.ts';

const directory = fs.mkdtempSync(join(tmpdir(), 'dne-fetch-lock-'));
const targets: string[] = [];
const handles: { release(): void; }[] = [];

afterEach(() => {
  mock.restore();
  for (const handle of handles.splice(0)) {
    handle.release();
  }
  for (const target of targets.splice(0)) {
    fs.rmSync(fetchLockPath(target), { force: true, recursive: true });
  }
});
afterAll(() => fs.rmSync(directory, { force: true, recursive: true }));

function target() {
  const path = join(directory, `${crypto.randomUUID()}.db`);
  targets.push(path);
  return path;
}

function legacyPath(path: string) {
  return join(dirname(path), `.${basename(path)}.fetch.lock`);
}

function progress() {
  return Object.assign(mock((_message: string) => {}), { finish: mock(() => {}) });
}

function fsError(code: string) {
  return Object.assign(new Error(`injected ${code}`), { code });
}

test('waits for an active owner, finishes progress, and releases idempotently', async () => {
  const path = target();
  const first = await acquireFetchLock(path, progress());
  handles.push(first);
  const reporter = progress();
  const timer = setTimeout(() => first.release(), 5);
  try {
    const second = await acquireFetchLock(path, reporter);
    handles.push(second);
    expect(reporter).toHaveBeenCalledWith('Aguardando outra atualização da base');
    expect(reporter.finish).toHaveBeenCalledTimes(1);
    second.release();
    second.release();
    expect(fs.existsSync(fetchLockPath(path))).toBe(false);
  } finally {
    clearTimeout(timer);
  }
});

test('times out while a legacy directory is still owned by a running process', async () => {
  const path = target();
  const legacy = legacyPath(path);
  fs.mkdirSync(legacy);
  fs.writeFileSync(join(legacy, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'active' }));
  spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(30_001);
  expect(await captureRejection(acquireFetchLock(path, progress()))).toMatchObject({ code: 'update-in-progress' });
  expect(fs.existsSync(legacy)).toBe(true);
});

test('waits for a busy legacy SQLite lock and recovers it when released', async () => {
  const path = target();
  const legacy = legacyPath(path);
  const db = new Database(legacy);
  db.run('CREATE TABLE lock (id INTEGER)');
  db.run('BEGIN IMMEDIATE');
  const sleep = spyOn(Bun, 'sleep').mockImplementation(async () => {
    db.run('ROLLBACK');
  });
  try {
    const lock = await acquireFetchLock(path, progress());
    handles.push(lock);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(legacy)).toBe(false);
  } finally {
    db.close();
  }
});

test('propagates corrupt legacy SQLite lock errors', async () => {
  const path = target();
  fs.writeFileSync(legacyPath(path), 'not SQLite');
  expect(await captureRejection(acquireFetchLock(path, progress()))).toMatchObject({ message: expect.stringContaining('not a database') });
});

test.each(['missing', 'invalid'])('recovers a legacy directory with %s owner metadata', async (kind) => {
  const path = target();
  const legacy = legacyPath(path);
  fs.mkdirSync(legacy);
  if (kind === 'invalid') {
    fs.writeFileSync(join(legacy, 'owner.json'), JSON.stringify({ pid: -1, token: 7 }));
  }
  const lock = await acquireFetchLock(path, progress());
  handles.push(lock);
  expect(fs.existsSync(legacy)).toBe(false);
});

test('leaves a replacement owner intact when releasing an old handle', async () => {
  const path = target();
  const lock = await acquireFetchLock(path, progress());
  handles.push(lock);
  fs.writeFileSync(join(fetchLockPath(path), 'owner.json'), JSON.stringify({ pid: process.pid, token: 'replacement' }));
  lock.release();
  expect(fs.existsSync(fetchLockPath(path))).toBe(true);
});

test.each(['SIGTERM', 'exit'] as const)('releases its lock in the %s process handler', async (event) => {
  const path = target();
  const before = new Set(process.listeners(event));
  const lock = await acquireFetchLock(path, progress());
  handles.push(lock);
  const handler = process.listeners(event).find((listener) => !before.has(listener));
  expect(handler).toBeDefined();
  const kill = spyOn(process, 'kill').mockReturnValue(true);
  handler?.(0);
  expect(fs.existsSync(fetchLockPath(path))).toBe(false);
  if (event === 'SIGTERM') {
    expect(kill).toHaveBeenCalledWith(process.pid, event);
  } else {
    expect(kill).not.toHaveBeenCalled();
  }
});

test('propagates errors while inspecting the obsolete lock path', async () => {
  const path = target();
  const legacy = legacyPath(path);
  fs.symlinkSync(legacy, legacy);
  expect(await captureRejection(acquireFetchLock(path, progress()))).toMatchObject({ code: 'ELOOP' });
});

test('removes a candidate directory when publishing the lock fails', async () => {
  const path = target();
  const destination = fetchLockPath(path);
  const rename = fs.renameSync;
  spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === destination) {
      throw fsError('EIO');
    }
    return rename(from, to);
  });
  expect(await captureRejection(acquireFetchLock(path, progress()))).toMatchObject({ code: 'EIO' });
  expect(fs.readdirSync(dirname(destination)).filter((entry) => entry.startsWith(basename(destination)))).toEqual([]);
});

test.each(['ENOENT', 'EIO'])('handles %s while rechecking a stale directory', async (code) => {
  const path = target();
  const legacy = legacyPath(path);
  fs.mkdirSync(legacy);
  let checks = 0;
  const stat = fs.statSync;
  spyOn(fs, 'statSync').mockImplementation(
    ((...args: Parameters<typeof fs.statSync>) => {
      if (args[0] === legacy && ++checks === 2) {
        fs.rmSync(legacy, { recursive: true });
        throw fsError(code);
      }
      return stat(...args);
    }) as typeof fs.statSync,
  );
  if (code === 'ENOENT') {
    handles.push(await acquireFetchLock(path, progress()));
    expect(fs.existsSync(fetchLockPath(path))).toBe(true);
  } else {
    expect(await captureRejection(acquireFetchLock(path, progress()))).toMatchObject({ code });
  }
});

test.each(['EEXIST', 'ENOENT', 'EIO'])('handles %s when claiming a stale directory', async (code) => {
  const path = target();
  const legacy = legacyPath(path);
  fs.mkdirSync(legacy);
  const write = fs.writeFileSync;
  spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
    if (args[0] === join(legacy, 'reaper.json')) {
      if (code === 'ENOENT') {
        fs.rmSync(legacy, { recursive: true });
      }
      throw fsError(code);
    }
    return write(...args);
  });
  spyOn(Bun, 'sleep').mockImplementation(async () => {
    fs.rmSync(legacy, { recursive: true });
  });
  if (code === 'EIO') {
    expect(await captureRejection(acquireFetchLock(path, progress()))).toMatchObject({ code });
  } else {
    handles.push(await acquireFetchLock(path, progress()));
    expect(fs.existsSync(legacy)).toBe(false);
  }
});

test.each(['missing', 'conflict', 'directory', 'vanished', 'stat-error', 'unchanged'])(
  'handles a legacy lock removal race: %s',
  async (scenario) => {
    const path = target();
    const legacy = legacyPath(path);
    new Database(legacy).close();
    const remove = fs.rmSync;
    const stat = fs.statSync;
    let removalAttempted = false;
    spyOn(fs, 'rmSync').mockImplementation((...args) => {
      if (args[0] === legacy && !removalAttempted) {
        removalAttempted = true;
        if (['missing', 'directory', 'vanished'].includes(scenario)) {
          remove(legacy);
        }
        if (scenario === 'directory') {
          fs.mkdirSync(legacy);
        }
        throw fsError(scenario === 'missing' ? 'ENOENT' : scenario === 'conflict' ? 'EACCES' : 'EIO');
      }
      return remove(...args);
    });
    spyOn(fs, 'statSync').mockImplementation(
      ((...args: Parameters<typeof fs.statSync>) => {
        if (args[0] === legacy && removalAttempted && scenario === 'stat-error') {
          throw fsError('ENOTDIR');
        }
        return stat(...args);
      }) as typeof fs.statSync,
    );
    spyOn(Bun, 'sleep').mockImplementation(async () => {
      remove(legacy, { force: true, recursive: true });
    });
    if (scenario === 'stat-error' || scenario === 'unchanged') {
      expect(await captureRejection(acquireFetchLock(path, progress()))).toMatchObject({
        code: scenario === 'stat-error' ? 'ENOTDIR' : 'EIO',
      });
    } else {
      handles.push(await acquireFetchLock(path, progress()));
      expect(fs.existsSync(legacy)).toBe(false);
    }
  },
);
