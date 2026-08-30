import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import packageJson from '../package.json';
import { renderSqlCodeBlock } from '../src/cli.ts';
import {
  createFixture,
  createNestedZipFixture,
} from './helpers.ts';

const workDir = mkdtempSync(join(tmpdir(), 'edne-cli-test-'));
const sourcePath = join(workDir, 'source');
const databasePath = join(workDir, 'dne.db');

beforeAll(() => {
  createFixture(sourcePath, 20);
  const result = runCli(['fetch', '--db', databasePath, '--source', sourcePath, '--quiet']);
  expect(result.status).toBe(0);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('CLI contract', () => {
  test('highlights SQL comments without highlighting their contents', () => {
    const sql = 'CREATE -- TABLE remains a comment\n/* PRIMARY KEY */ "dne" TEXT';
    const highlighted = renderSqlCodeBlock(sql, true);

    expect(highlighted).toContain('\x1b[1mCREATE\x1b[0m');
    expect(highlighted).toContain('\x1b[90m-- TABLE remains a comment\x1b[0m');
    expect(highlighted).toContain('\x1b[90m/* PRIMARY KEY */\x1b[0m');
    expect(highlighted).not.toContain('-- \x1b[1mTABLE');
    expect(renderSqlCodeBlock(sql, false)).toBe(sql);
  });

  test('shows the complete command surface and package version', () => {
    const help = runCli(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('fetch');
    expect(help.stdout).toContain('lookup');
    expect(help.stdout).toContain('status');
    expect(help.stdout).toContain('doctor');
    expect(help.stdout).toContain('sql');

    const version = runCli(['--version']);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(`dne ${packageJson.version}`);
  });

  test('returns a stable JSON lookup envelope', () => {
    const current = runCli(['lookup', '30000-001', '--db', databasePath, '--json']);
    expect(current.status).toBe(0);
    const currentJson = parseJson(current.stdout);
    expect(currentJson.ok).toBe(true);
    expect(currentJson.data.results[0]).toMatchObject({ cep: '30000001', found: true });
  });

  test('keeps lookup read-only and does not create a missing database', () => {
    const missingPath = join(workDir, 'missing.db');
    const result = runCli(['lookup', '30000001', '--db', missingPath, '--json']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(parseJson(result.stderr)).toMatchObject({
      ok: false,
      error: { code: 'database-not-found' },
    });
    expect(existsSync(missingPath)).toBe(false);

    expect(existsSync(`${databasePath}-wal`)).toBe(false);
    expect(existsSync(`${databasePath}-shm`)).toBe(false);
  });

  test('distinguishes invalid CEP input from a valid missing CEP', () => {
    const invalid = runCli(['lookup', 'abc', '--db', databasePath, '--json']);
    expect(invalid.status).toBe(2);
    expect(parseJson(invalid.stderr).error.code).toBe('invalid-arguments');

    const legacyDatabase = runCli(['lookup', databasePath, '30000001', '--json']);
    expect(legacyDatabase.status).toBe(2);
    expect(parseJson(legacyDatabase.stderr).error.code).toBe('invalid-arguments');

    const missing = runCli(['lookup', '99999999', '--db', databasePath, '--json']);
    expect(missing.status).toBe(3);
    expect(parseJson(missing.stdout).data.results[0]).toMatchObject({
      cep: '99999999',
      found: false,
    });
  });

  test('supports JSONL bulk input from arguments, files, and stdin', () => {
    const argumentsResult = runCli([
      'lookup',
      '30000001',
      '30000-002',
      '--db',
      databasePath,
      '--jsonl',
    ]);
    expect(argumentsResult.status).toBe(0);
    expect(parseJsonLines(argumentsResult.stdout)).toHaveLength(2);

    const inputPath = join(workDir, 'ceps.txt');
    writeFileSync(inputPath, '30000001, 30000-002\n');
    const fileResult = runCli(['lookup', '--file', inputPath, '--db', databasePath, '--jsonl']);
    expect(fileResult.status).toBe(0);
    expect(parseJsonLines(fileResult.stdout).map((value) => value.data.result.cep)).toEqual(['30000001', '30000002']);

    const stdinResult = runCli(['lookup', '--db', databasePath, '--jsonl'], '30000001\n30000002\n');
    expect(stdinResult.status).toBe(0);
    expect(parseJsonLines(stdinResult.stdout)).toHaveLength(2);
  });

  test('reports status, actual schema, expected schema, and offline doctor state', () => {
    const status = runCli(['--json', 'status', '--db', databasePath]);
    expect(status.status).toBe(0);
    expect(parseJson(status.stdout).data).toMatchObject({ ready: true, row_count: 24 });

    const statusText = runCli(['status', '--db', databasePath]);
    expect(statusText.status).toBe(0);
    expect(statusText.stdout).toMatch(/Size: \d+,\d KiB/);
    expect(statusText.stdout).toMatch(/Loaded at: \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}/);
    expect(statusText.stdout).toContain(`Package: @konstit/dne@${packageJson.version}`);
    expect(statusText.stdout).toContain('Source Last-Modified: -');

    const schema = runCli(['schema', '--db', databasePath, '--json']);
    expect(schema.status).toBe(0);
    expect(parseJson(schema.stdout).data).toMatchObject({ source: 'database', table: 'dne' });

    const schemaText = runCli(['schema', '--db', databasePath]);
    expect(schemaText.status).toBe(0);
    expect(schemaText.stdout).toContain(
      'CREATE TABLE "dne" (\n  "cep" TEXT NOT NULL /* Contém somente os oito dígitos do CEP, sem separadores. */,\n',
    );
    expect(schemaText.stdout).toContain('\n  PRIMARY KEY ("cep")\n) WITHOUT ROWID');

    const expected = runCli(['schema', '--expected', '--json']);
    expect(expected.status).toBe(0);
    expect(parseJson(expected.stdout).data).toMatchObject({ source: 'declared', table: 'dne' });
    expect(parseJson(expected.stdout).data.sql).toContain('oito dígitos do CEP, sem separadores');

    const colorEnvironment = { ...process.env };
    delete colorEnvironment['NO_COLOR'];
    const colored = runCli(['schema', '--expected', '--color'], undefined, colorEnvironment);
    expect(colored.status).toBe(0);
    expect(colored.stdout).toContain('\x1b[1mCREATE\x1b[0m');

    const plain = runCli(['schema', '--expected', '--no-color']);
    expect(plain.status).toBe(0);
    expect(plain.stdout).not.toContain('\x1b[');

    const doctor = runCli(['doctor', '--offline', '--db', databasePath, '--json']);
    expect(doctor.status).toBe(0);
    expect(parseJson(doctor.stdout).data).toMatchObject({
      auth: { required: false, source: 'not-required' },
      healthy: true,
      runtime: { compatible: true, name: 'bun' },
    });
  });

  test('returns a JSON fetch summary and keeps progress on stderr', () => {
    const target = join(workDir, 'fetch-summary.db');
    const result = runCli(['fetch', '--db', target, '--source', sourcePath, '--json']);
    expect(result.status).toBe(0);
    expect(parseJson(result.stdout).data).toMatchObject({
      database: {
        metadata: { package_version: packageJson.version },
        path: target,
        ready: true,
        row_count: 24,
      },
      source: { kind: 'local' },
      status: 'created',
    });
    for (
      const step of [
        'Reading directory source',
        'Directory source is ready',
        'Loading the SQLite database',
        'Reading municipalities',
        'Reading districts',
        'Loading streets',
        'Loading municipalities',
        'Loading special addresses',
        'Committing the database',
      ]
    ) {
      expect(result.stderr).toContain(`${step} (`);
    }
    expect(result.stderr.split('\n').filter(Boolean).every((line) => / \(\d+ms\)$/.test(line))).toBe(true);

    const check = runCli(['fetch', '--check', '--db', target, '--source', sourcePath, '--json']);
    expect(check.status).toBe(0);
    expect(parseJson(check.stdout).data.status).toBe('unknown');

    const checkOnlyTarget = join(workDir, 'check-only.db');
    const checkOnly = runCli(['fetch', '--check', '--db', checkOnlyTarget, '--source', sourcePath, '--json']);
    expect(checkOnly.status).toBe(0);
    expect(existsSync(temporaryFetchLockPath(checkOnlyTarget))).toBe(false);
  });

  test('stores and reports the remote Last-Modified header and package version', async () => {
    const fixturePath = createNestedZipFixture(join(workDir, 'remote-fixture'), 20);
    const fixture = Bun.file(fixturePath);
    const lastModified = 'Sun, 30 Aug 2026 07:00:00 GMT';
    let downloadCount = 0;
    let notifyDownloadStarted: (() => void) | undefined;
    const downloadStarted = new Promise<void>((resolve) => {
      notifyDownloadStarted = resolve;
    });
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (request.method !== 'HEAD') {
          downloadCount++;
          notifyDownloadStarted?.();
          await Bun.sleep(100);
        }
        const headers = {
          'content-length': String(fixture.size),
          'last-modified': lastModified,
        };
        return new Response(request.method === 'HEAD' ? null : fixture, { headers });
      },
    });

    try {
      const url = `http://${server.hostname}:${server.port}/eDNE_Basico.zip`;
      const remoteDatabase = join(workDir, 'remote.db');
      const firstFetch = runCliAsync([
        'fetch',
        '--db',
        remoteDatabase,
        '--source',
        url,
        '--json',
      ]);
      await downloadStarted;
      const concurrentFetch = runCliAsync(['fetch', '--db', remoteDatabase, '--source', url]);
      const [result, unchanged,] = await Promise.all([firstFetch, concurrentFetch]);

      expect(result.status).toBe(0);
      expect(parseJson(result.stdout).data.database.metadata).toMatchObject({
        package_version: packageJson.version,
        source_last_modified: lastModified,
        source_url: url,
      });

      expect(unchanged.status).toBe(0);
      expect(unchanged.stderr).toMatch(/Aguardando outra atualização da base \(\d+ms\)/);
      expect(unchanged.stdout).toContain('A base DNE já está atualizada:');
      expect(unchanged.stdout).toContain('24 registros, 128,0 KiB');
      expect(unchanged.stdout).toMatch(/Última modificação na fonte: 30\/08\/2026, \d{2}:00:00/);
      expect(unchanged.stdout).toMatch(/Verificação concluída em \d+ ms\./);
      expect(unchanged.stdout).not.toContain('Unchanged');
      expect(downloadCount).toBe(1);
      expect(existsSync(temporaryFetchLockPath(remoteDatabase))).toBe(false);
      expect(existsSync(join(workDir, '.remote.db.fetch.lock'))).toBe(false);

      const check = await runCliAsync(['fetch', '--check', '--db', remoteDatabase, '--source', url]);
      expect(check.status).toBe(0);
      expect(check.stdout).toMatch(/Última modificação na fonte: 30\/08\/2026, \d{2}:00:00/);

      const status = await runCliAsync(['status', '--db', remoteDatabase]);
      expect(status.status).toBe(0);
      expect(status.stdout).toContain(`Package: @konstit/dne@${packageJson.version}`);
      expect(status.stdout).toMatch(/Source Last-Modified: 30\/08\/2026, \d{2}:00:00/);
    } finally {
      await server.stop(true);
    }
  });

  test('removes the fetch lock when the process receives SIGTERM', async () => {
    const fixturePath = createNestedZipFixture(join(workDir, 'signal-fixture'), 20);
    const fixture = Bun.file(fixturePath);
    let notifyDownloadStarted: (() => void) | undefined;
    let releaseDownload: (() => void) | undefined;
    const downloadStarted = new Promise<void>((resolve) => {
      notifyDownloadStarted = resolve;
    });
    const downloadReleased = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (request.method !== 'HEAD') {
          notifyDownloadStarted?.();
          await downloadReleased;
        }
        return new Response(request.method === 'HEAD' ? null : fixture, {
          headers: { 'content-length': String(fixture.size) },
        });
      },
    });
    const target = join(workDir, 'signal.db');
    const lockPath = temporaryFetchLockPath(target);
    const child = Bun.spawn([
      'bun',
      'run',
      'src/index.ts',
      'fetch',
      '--db',
      target,
      '--source',
      `http://${server.hostname}:${server.port}/eDNE_Basico.zip`,
    ], {
      cwd: process.cwd(),
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const stderr = new Response(child.stderr).text();
    const stdout = new Response(child.stdout).text();

    try {
      await downloadStarted;
      expect(existsSync(lockPath)).toBe(true);
      child.kill('SIGTERM');
      await child.exited;
      await Promise.all([stderr, stdout]);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      releaseDownload?.();
      child.kill('SIGKILL');
      await server.stop(true);
    }
  });

  test('recovers a lock left by a process that no longer exists', () => {
    const target = join(workDir, 'stale-lock.db');
    const lockPath = temporaryFetchLockPath(target);
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      join(lockPath, 'owner.json'),
      JSON.stringify({ pid: 2_147_483_647, token: 'stale-owner' }),
    );

    const result = runCli(['fetch', '--db', target, '--source', sourcePath, '--quiet']);

    expect(result.status).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('supports bounded read-only SQL and rejects write commands', () => {
    const read = runCli([
      'sql',
      'SELECT cep, uf FROM dne ORDER BY cep',
      '--limit',
      '2',
      '--db',
      databasePath,
      '--json',
    ]);
    expect(read.status).toBe(0);
    expect(parseJson(read.stdout).data).toMatchObject({ limit: 2, truncated: true });

    const write = runCli(['sql', 'DELETE FROM dne', '--db', databasePath, '--json']);
    expect(write.status).toBe(2);
    expect(parseJson(write.stderr).error.code).toBe('write-query-denied');
  });

  test('returns machine-readable parser failures under --json', () => {
    const result = runCli(['fetch', '--force', '--check', '--json']);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(parseJson(result.stderr)).toMatchObject({
      ok: false,
      error: { code: 'invalid-arguments' },
    });

    const positionalDatabase = runCli(['fetch', './legacy.db', '--json']);
    expect(positionalDatabase.status).toBe(2);
    expect(parseJson(positionalDatabase.stderr)).toMatchObject({
      ok: false,
      error: { code: 'invalid-arguments' },
    });
  });
});

function runCli(args: string[], input?: string, env = process.env) {
  return spawnSync('bun', ['run', 'src/index.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
    input,
  });
}

async function runCliAsync(args: string[]) {
  const child = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
    cwd: process.cwd(),
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [status, stderr, stdout,] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { status, stderr, stdout };
}

function parseJson(value: string) {
  return JSON.parse(value);
}

function parseJsonLines(value: string) {
  return value
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => parseJson(line));
}

function temporaryFetchLockPath(target: string) {
  const targetHash = new Bun.CryptoHasher('sha256').update(target).digest('hex');
  return join(tmpdir(), `konstit-dne-${process.getuid?.() ?? 'unknown'}`, `fetch-${targetHash}.lock`);
}
