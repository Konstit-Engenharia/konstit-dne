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
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import packageJson from '../package.json';
import {
  formatDuration,
  renderSqlCodeBlock,
} from '../src/cli.ts';
import {
  createFixture,
  createNestedZipFixture,
} from './helpers.ts';

const workDir = mkdtempSync(join(tmpdir(), 'edne-cli-test-'));
const sourcePath = join(workDir, 'source');
const databasePath = join(workDir, 'dne.db');

beforeAll(() => {
  createFixture(sourcePath, 20);
  const result = runCli(['build', '--db', databasePath, '--source', sourcePath, '--quiet']);
  expect(result.status).toBe(0);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('CLI contract', () => {
  test('formats elapsed time for people while keeping short steps precise', () => {
    expect(formatDuration(999)).toBe('999 ms');
    expect(formatDuration(1_250)).toBe('1,3 s');
    expect(formatDuration(60_000)).toBe('1 min');
    expect(formatDuration(61_000)).toBe('1 min 1 s');
    expect(formatDuration(3_661_000)).toBe('1 h 1 min 1 s');
  });

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
    expect(help.stdout).toContain('build');
    expect(help.stdout).toContain('get');
    expect(help.stdout).not.toContain('fetch');
    expect(help.stdout).not.toContain('lookup');
    expect(help.stdout).toContain('status');
    expect(help.stdout).toContain('doctor');
    expect(help.stdout).toContain('sql');
    expect(help.stdout).toContain('cron');
    expect(help.stdout).toContain('Uso: dne [OPTIONS] <COMMAND>');
    expect(help.stdout).toContain('Comandos:');
    expect(help.stdout).toContain('Opções:');
    expect(help.stdout).not.toContain('Usage:');

    const version = runCli(['--version']);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(`dne ${packageJson.version}`);
  });

  test('detects terminal colors when translated output writers are active', () => {
    const colorEnvironment: Record<string, string | undefined> = {
      ...process.env,
      TERM: 'xterm-256color',
    };
    delete colorEnvironment['NO_COLOR'];

    const automatic = runCliWithStdoutTty(['--help'], colorEnvironment);
    expect(automatic.status).toBe(0);
    expect(automatic.stdout).toContain('\x1b[');

    const disabled = runCliWithStdoutTty(['--no-color', '--help'], colorEnvironment);
    expect(disabled.status).toBe(0);
    expect(disabled.stdout).not.toContain('\x1b[');

    const noColor = runCliWithStdoutTty(['--help'], { ...colorEnvironment, NO_COLOR: '1' });
    expect(noColor.status).toBe(0);
    expect(noColor.stdout).not.toContain('\x1b[');
  });

  test('uses Bun.cron to install, report, update, and remove schedules', () => {
    const cronCalls = join(workDir, 'bun-cron-calls.jsonl');
    const cronState = join(workDir, 'bun-cron-state');
    const cronEnvironment: Record<string, string | undefined> = {
      ...process.env,
      DNE_TEST_CRON_CALLS: cronCalls,
      XDG_STATE_HOME: cronState,
    };
    const target = join(workDir, 'cron % friday\'s.db');
    const scheduledSource = join(workDir, 'source % friday\'s.zip');

    const missing = runCliWithFakeCron(['cron', 'status', '--db', target, '--json'], cronEnvironment);
    expect(missing.status).toBe(0);
    expect(parseJson(missing.stdout).data).toMatchObject({
      database: target,
      installed: false,
    });

    const preview = runCliWithFakeCron(
      ['cron', 'install', '--dry-run', '--db', target, '--json'],
      cronEnvironment,
    );
    expect(preview.status).toBe(0);
    expect(parseJson(preview.stdout).data).toMatchObject({
      database: target,
      expression: '0 0 * * 5',
      package_version: packageJson.version,
      status: 'preview',
    });
    expect(existsSync(cronCalls)).toBe(false);
    expect(existsSync(cronState)).toBe(false);

    const installed = runCliWithFakeCron(
      ['cron', 'install', '--db', target, '--source', scheduledSource, '--json'],
      cronEnvironment,
    );
    expect(installed.status).toBe(0);
    const installedData = parseJson(installed.stdout).data;
    expect(installedData).toMatchObject({
      database: target,
      expression: '0 0 * * 5',
      package_version: packageJson.version,
      source: scheduledSource,
      status: 'installed',
    });
    expect(installedData.id).toMatch(/^konstit-dne-[a-f0-9]{32}$/);
    expect(installedData.next_run).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(installedData.command).toContain(`@konstit/dne@${packageJson.version}`);
    expect(installedData.command).toContain(' build --db ');
    expect(installedData.command).toContain('%');
    expect(installedData.command).toContain('\'\\\'\'');
    expect(readFileSync(installedData.runner, 'utf8')).toContain(JSON.stringify(target));
    expect(readFileSync(installedData.runner, 'utf8')).toContain(JSON.stringify(scheduledSource));
    expect(readFileSync(installedData.runner, 'utf8')).toContain(`@konstit/dne@${packageJson.version}`);
    expect(readCronCalls(cronCalls)[0]).toMatchObject({
      action: 'install',
      path: installedData.runner,
      schedule: '0 0 * * 5',
      title: installedData.title,
    });

    const updated = runCliWithFakeCron(
      ['cron', 'install', '30 6 * * 5', '--db', target, '--json'],
      cronEnvironment,
    );
    expect(updated.status).toBe(0);
    expect(parseJson(updated.stdout).data.status).toBe('updated');
    expect(readCronCalls(cronCalls).at(-1)).toMatchObject({
      action: 'install',
      schedule: '30 6 * * 5',
      title: installedData.title,
    });

    const status = runCliWithFakeCron(['cron', 'status', '--db', target, '--json'], cronEnvironment);
    expect(status.status).toBe(0);
    expect(parseJson(status.stdout).data).toMatchObject({
      database: target,
      expression: '30 6 * * 5',
      installed: true,
      package_version: packageJson.version,
      source: scheduledSource,
    });

    const otherTarget = join(workDir, 'other-cron.db');
    const otherInstalled = runCliWithFakeCron(
      ['cron', 'install', '--db', otherTarget, '--json'],
      cronEnvironment,
    );
    expect(otherInstalled.status).toBe(0);
    expect(parseJson(otherInstalled.stdout).data.title).not.toBe(installedData.title);

    const removed = runCliWithFakeCron(['cron', 'remove', '--db', target, '--json'], cronEnvironment);
    expect(removed.status).toBe(0);
    expect(parseJson(removed.stdout).data.removed).toBe(true);
    expect(existsSync(installedData.runner)).toBe(false);
    expect(readCronCalls(cronCalls).at(-1)).toMatchObject({
      action: 'remove',
      title: installedData.title,
    });

    const removedAgain = runCliWithFakeCron(['cron', 'remove', '--db', target, '--json'], cronEnvironment);
    expect(removedAgain.status).toBe(0);
    expect(parseJson(removedAgain.stdout).data.removed).toBe(false);

    const otherRemoved = runCliWithFakeCron(
      ['cron', 'remove', '--db', otherTarget, '--json'],
      cronEnvironment,
    );
    expect(otherRemoved.status).toBe(0);
    expect(existsSync(parseJson(otherInstalled.stdout).data.runner)).toBe(false);

    const invalid = runCliWithFakeCron(['cron', 'install', 'not cron', '--json'], cronEnvironment);
    expect(invalid.status).toBe(2);
    expect(parseJson(invalid.stderr.slice(invalid.stderr.indexOf('{'))).error.message).toContain('expressão cron válida');
  });

  test('returns a stable JSON get envelope', () => {
    const current = runCli(['get', '30000-001', '--db', databasePath, '--json']);
    expect(current.status).toBe(0);
    const currentJson = parseJson(current.stdout);
    expect(currentJson.ok).toBe(true);
    expect(currentJson.data.results[0]).toMatchObject({ cep: '30000001', found: true });
  });

  test('keeps get read-only and does not create a missing database', () => {
    const missingPath = join(workDir, 'missing.db');
    const result = runCli(['get', '30000001', '--db', missingPath, '--json']);
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
    const invalid = runCli(['get', 'abc', '--db', databasePath, '--json']);
    expect(invalid.status).toBe(2);
    expect(parseJson(invalid.stderr).error.code).toBe('invalid-cep');
    expect(parseJson(invalid.stderr).error.message).toContain('CEP inválido');

    const invalidText = runCli(['get', 'abc']);
    expect(invalidText.status).toBe(2);
    expect(invalidText.stderr).toContain('erro: CEP inválido');
    expect(invalidText.stderr).not.toContain('Usage:');

    const legacyDatabase = runCli(['get', databasePath, '30000001', '--json']);
    expect(legacyDatabase.status).toBe(2);
    expect(parseJson(legacyDatabase.stderr).error.code).toBe('invalid-cep');

    const missing = runCli(['get', '99999999', '--db', databasePath, '--json']);
    expect(missing.status).toBe(3);
    expect(parseJson(missing.stdout).data.results[0]).toMatchObject({
      cep: '99999999',
      found: false,
    });
  });

  test('reports invalid CEPs after valid inputs in a batch', () => {
    const result = runCli(['get', '30000001', 'abc', '--db', databasePath, '--json']);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(parseJson(result.stderr)).toMatchObject({
      ok: false,
      error: { code: 'invalid-cep', details: { input: 'abc' } },
    });
  });

  test('supports JSONL bulk input from arguments, files, and stdin', () => {
    const argumentsResult = runCli([
      'get',
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
    const fileResult = runCli(['get', '--file', inputPath, '--db', databasePath, '--jsonl']);
    expect(fileResult.status).toBe(0);
    expect(parseJsonLines(fileResult.stdout).map((value) => value.data.result.cep)).toEqual(['30000001', '30000002']);

    const stdinResult = runCli(['get', '--db', databasePath, '--jsonl'], '30000001\n30000002\n');
    expect(stdinResult.status).toBe(0);
    expect(parseJsonLines(stdinResult.stdout)).toHaveLength(2);
  });

  test('reports status, actual schema, expected schema, and offline doctor state', () => {
    const status = runCli(['--json', 'status', '--db', databasePath]);
    expect(status.status).toBe(0);
    expect(parseJson(status.stdout).data).toMatchObject({ ready: true, row_count: 24 });

    const statusText = runCli(['status', '--db', databasePath]);
    expect(statusText.status).toBe(0);
    expect(statusText.stdout).toMatch(/Tamanho: \d+,\d KiB/);
    expect(statusText.stdout).toMatch(/Carregada em: \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}/);
    expect(statusText.stdout).toContain(`Pacote: @konstit/dne@${packageJson.version}`);
    expect(statusText.stdout).toContain('Última modificação da fonte: -');

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

    const doctorText = runCli(['doctor', '--offline', '--db', databasePath]);
    expect(doctorText.status).toBe(0);
    expect(doctorText.stdout).toContain('Ambiente: bun');
    expect(doctorText.stdout).toContain('Base: pronta');
    expect(doctorText.stdout).toContain('Fonte: não verificada');
    expect(doctorText.stdout).toContain('Saudável: sim');

    const missingDoctor = runCli([
      'doctor',
      '--offline',
      '--db',
      join(workDir, 'missing-doctor.db'),
      '--json',
    ]);
    expect(missingDoctor.status).toBe(1);
    expect(parseJson(missingDoctor.stdout).data).toMatchObject({
      database: { ready: false },
      healthy: false,
    });
  });

  test('returns a JSON build summary and keeps progress on stderr', () => {
    const target = join(workDir, 'build-summary.db');
    const result = runCli(['build', '--db', target, '--source', sourcePath, '--json']);
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
        'Lendo a fonte do diretório',
        'Fonte do diretório pronta',
        'Carregando a base SQLite',
        'Lendo municípios',
        'Lendo bairros',
        'Carregando logradouros',
        'Carregando municípios',
        'Carregando endereços especiais',
        'Confirmando a base SQLite',
      ]
    ) {
      expect(result.stderr).toContain(`${step} (`);
    }
    expect(result.stderr.split('\n').filter(Boolean).every((line) => / \(\d+ ms\)$/.test(line))).toBe(true);

    const check = runCli(['build', '--check', '--db', target, '--source', sourcePath, '--json']);
    expect(check.status).toBe(0);
    expect(parseJson(check.stdout).data.status).toBe('unknown');

    const checkOnlyTarget = join(workDir, 'check-only.db');
    const checkOnly = runCli(['build', '--check', '--db', checkOnlyTarget, '--source', sourcePath, '--json']);
    expect(checkOnly.status).toBe(0);
    expect(existsSync(temporaryFetchLockPath(checkOnlyTarget))).toBe(false);

    const missingSource = runCli([
      'build',
      '--check',
      '--db',
      checkOnlyTarget,
      '--source',
      join(workDir, 'missing-source'),
      '--json',
    ]);
    expect(missingSource.status).toBe(1);
    expect(parseJson(missingSource.stderr.slice(missingSource.stderr.indexOf('{'))).error.code).toBe('source-unavailable');
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
        'build',
        '--db',
        remoteDatabase,
        '--source',
        url,
        '--json',
      ]);
      await downloadStarted;
      const concurrentFetch = runCliAsync(['build', '--db', remoteDatabase, '--source', url]);
      const [result, unchanged,] = await Promise.all([firstFetch, concurrentFetch]);

      expect(result.status).toBe(0);
      expect(parseJson(result.stdout).data.database.metadata).toMatchObject({
        package_version: packageJson.version,
        source_last_modified: lastModified,
        source_url: url,
      });

      expect(unchanged.status).toBe(0);
      expect(unchanged.stderr).toMatch(/Aguardando outra atualização da base \(\d+ ms\)/);
      expect(unchanged.stdout).toContain('A base DNE já está atualizada:');
      expect(unchanged.stdout).toMatch(/24 registros, \d+,\d KiB/);
      expect(unchanged.stdout).toMatch(/Última modificação na fonte: 30\/08\/2026, \d{2}:00:00/);
      expect(unchanged.stdout).toMatch(/Verificação concluída em \d+ ms\./);
      expect(unchanged.stdout).not.toContain('Unchanged');
      expect(downloadCount).toBe(1);
      expect(existsSync(temporaryFetchLockPath(remoteDatabase))).toBe(false);
      expect(existsSync(join(workDir, '.remote.db.fetch.lock'))).toBe(false);

      const check = await runCliAsync(['build', '--check', '--db', remoteDatabase, '--source', url]);
      expect(check.status).toBe(0);
      expect(check.stdout).toContain('Estado: atualizada');
      expect(check.stdout).toMatch(/Última modificação na fonte: 30\/08\/2026, \d{2}:00:00/);

      const status = await runCliAsync(['status', '--db', remoteDatabase]);
      expect(status.status).toBe(0);
      expect(status.stdout).toContain(`Pacote: @konstit/dne@${packageJson.version}`);
      expect(status.stdout).toMatch(/Última modificação da fonte: 30\/08\/2026, \d{2}:00:00/);
    } finally {
      await server.stop(true);
    }
  });

  test('removes the build lock when the process receives SIGTERM', async () => {
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
      'build',
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

    const result = runCli(['build', '--db', target, '--source', sourcePath, '--quiet']);

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
    const result = runCli(['build', '--force', '--check', '--json']);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(parseJson(result.stderr)).toMatchObject({
      ok: false,
      error: { code: 'invalid-arguments' },
    });

    const coloredJsonError = runCli(['--color', 'build', '--force', '--check', '--json']);
    expect(coloredJsonError.status).toBe(2);
    expect(coloredJsonError.stderr).not.toContain('\x1b[');
    expect(parseJson(coloredJsonError.stderr).error.message).not.toContain('erro:');

    const positionalDatabase = runCli(['build', './legacy.db', '--json']);
    expect(positionalDatabase.status).toBe(2);
    expect(parseJson(positionalDatabase.stderr)).toMatchObject({
      ok: false,
      error: { code: 'invalid-arguments' },
    });

    for (const retiredCommand of ['fetch', 'lookup']) {
      const retired = runCli([retiredCommand, '--json']);
      expect(retired.status).toBe(2);
      expect(parseJson(retired.stderr)).toMatchObject({
        ok: false,
        error: { code: 'invalid-arguments' },
      });
    }
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

function runCliWithStdoutTty(args: string[], env = process.env) {
  const source = [
    `Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });`,
    `const { runCli } = await import('./src/cli.ts');`,
    `process.exitCode = await runCli(${JSON.stringify(args)});`,
  ].join('\n');
  return spawnSync('bun', ['--eval', source], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
}

function runCliWithFakeCron(args: string[], env = process.env) {
  const source = [
    `const { appendFileSync } = await import('node:fs');`,
    `const parse = Bun.cron.parse.bind(Bun.cron);`,
    `const record = (value) => appendFileSync(Bun.env.DNE_TEST_CRON_CALLS, JSON.stringify(value) + '\\n');`,
    `const cron = async (path, schedule, title) => record({ action: 'install', path, schedule, title });`,
    `cron.parse = parse;`,
    `cron.remove = async (title) => record({ action: 'remove', title });`,
    `Bun.cron = cron;`,
    `const { runCli } = await import('./src/cli.ts');`,
    `process.exitCode = await runCli(${JSON.stringify(args)});`,
  ].join('\n');
  return spawnSync('bun', ['--eval', source], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  });
}

function readCronCalls(path: string) {
  return parseJsonLines(readFileSync(path, 'utf8'));
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
