import { Database } from 'bun:sqlite';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  join,
} from 'node:path';
import { UserError } from './errors.ts';

const FETCH_LOCK_TIMEOUT_MS = 30_000;
const FETCH_LOCK_RETRY_MS = 50;
const FETCH_LOCK_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;

type ProgressReporter = {
  (message: string): void;
  finish(): void;
};

type FetchLockOwner = {
  pid: number;
  token: string;
};

export async function acquireFetchLock(
  target: string,
  progress: ProgressReporter,
) {
  const path = fetchLockPath(target);
  const obsoletePath = join(dirname(target), `.${basename(target)}.fetch.lock`);
  const owner = { pid: process.pid, token: crypto.randomUUID() };
  const deadline = performance.now() + FETCH_LOCK_TIMEOUT_MS;
  let waiting = false;

  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });

  while (pathExists(obsoletePath)) {
    if (recoverStaleFetchLock(obsoletePath)) {
      continue;
    }
    await waitForFetchLock();
  }
  while (!tryCreateFetchLock(path, owner)) {
    if (recoverStaleFetchLock(path)) {
      continue;
    }
    await waitForFetchLock();
  }

  if (waiting) {
    progress.finish();
  }

  let released = false;
  let removeProcessHandlers = () => {};
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    removeProcessHandlers();
    removeOwnedFetchLock(path, owner.token);
  };
  removeProcessHandlers = installFetchLockProcessHandlers(release);

  return { release };

  async function waitForFetchLock() {
    if (!waiting) {
      progress('Aguardando outra atualização da base');
      waiting = true;
    }
    if (performance.now() >= deadline) {
      throw new UserError(
        'update-in-progress',
        `Outra execução de build já está atualizando a base '${target}'.`,
      );
    }
    await Bun.sleep(FETCH_LOCK_RETRY_MS);
  }
}

export function fetchLockPath(target: string) {
  const targetHash = new Bun.CryptoHasher('sha256').update(target).digest('hex');
  return join(tmpdir(), `konstit-dne-${process.getuid?.() ?? 'unknown'}`, `fetch-${targetHash}.lock`);
}

function pathExists(path: string) {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if (isMissingPath(error)) {
      return false;
    }
    throw error;
  }
}

function tryCreateFetchLock(path: string, owner: FetchLockOwner) {
  const candidate = `${path}.${owner.pid}.${owner.token}.tmp`;
  mkdirSync(candidate);
  try {
    writeFileSync(join(candidate, 'owner.json'), JSON.stringify(owner), { flag: 'wx' });
    renameSync(candidate, path);
    return true;
  } catch (error) {
    if (isPathConflict(error)) {
      return false;
    }
    throw error;
  } finally {
    rmSync(candidate, { force: true, recursive: true });
  }
}

function recoverStaleFetchLock(path: string) {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch (error) {
    if (isMissingPath(error)) {
      return true;
    }
    throw error;
  }

  if (!stats.isDirectory()) {
    return removeLegacyFetchLock(path);
  }

  const owner = readFetchLockOwner(path);
  if (owner && processIsRunning(owner.pid)) {
    return false;
  }

  try {
    writeFileSync(
      join(path, 'reaper.json'),
      JSON.stringify({ pid: process.pid, token: crypto.randomUUID() }),
      { flag: 'wx' },
    );
  } catch (error) {
    if (isPathConflict(error)) {
      return false;
    }
    if (isMissingPath(error)) {
      return true;
    }
    throw error;
  }

  rmSync(path, { force: true, recursive: true });
  return true;
}

function removeLegacyFetchLock(path: string) {
  const database = new Database(path);
  try {
    database.run('PRAGMA busy_timeout = 0');
    database.run('BEGIN IMMEDIATE');
    database.run('ROLLBACK');
  } catch (error) {
    if (isSqliteLockConflict(error)) {
      return false;
    }
    throw error;
  } finally {
    database.close();
  }
  try {
    rmSync(path, { force: true });
    return true;
  } catch (error) {
    if (isMissingPath(error)) {
      return true;
    }
    if (isPathConflict(error)) {
      return false;
    }
    try {
      if (statSync(path).isDirectory()) {
        return false;
      }
    } catch (statError) {
      if (isMissingPath(statError)) {
        return true;
      }
      throw statError;
    }
    throw error;
  }
}

function readFetchLockOwner(path: string): FetchLockOwner | null {
  try {
    const value = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')) as Partial<FetchLockOwner>;
    return Number.isInteger(value.pid) && Number(value.pid) > 0 && typeof value.token === 'string'
      ? { pid: Number(value.pid), token: value.token }
      : null;
  } catch {
    return null;
  }
}

function processIsRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'ESRCH'
    );
  }
}

function removeOwnedFetchLock(path: string, token: string) {
  if (readFetchLockOwner(path)?.token === token) {
    rmSync(path, { force: true, recursive: true });
  }
}

function installFetchLockProcessHandlers(release: () => void) {
  const exitHandler = () => release();
  const signalHandlers = FETCH_LOCK_SIGNALS.map((signal) => {
    const handler = () => {
      release();
      process.kill(process.pid, signal);
    };
    process.once(signal, handler);
    return { handler, signal };
  });
  process.once('exit', exitHandler);

  return () => {
    process.off('exit', exitHandler);
    for (const { handler, signal } of signalHandlers) {
      process.off(signal, handler);
    }
  };
}

function isPathConflict(error: unknown) {
  return errorHasCode(error, 'EACCES', 'EEXIST', 'ENOTEMPTY', 'EPERM');
}

function isMissingPath(error: unknown) {
  return errorHasCode(error, 'ENOENT');
}

function errorHasCode(error: unknown, ...codes: string[]) {
  return Boolean(
    error
      && typeof error === 'object'
      && 'code' in error
      && typeof error.code === 'string'
      && codes.includes(error.code),
  );
}

function isSqliteLockConflict(error: unknown) {
  if (errorHasCode(error, 'SQLITE_BUSY', 'SQLITE_LOCKED')) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|database table is locked/i.test(message);
}
