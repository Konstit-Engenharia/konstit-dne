import { Database } from 'bun:sqlite';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import packageJson from '../package.json';
import {
  formatDuration,
  renderSqlCodeBlock,
  runCli as executeCli,
} from '../src/cli.ts';
import { DneDatabaseReader } from '../src/db.ts';
import {
  createFixture,
  createNestedZipFixture,
} from './helpers.ts';

const workDir = mkdtempSync(join(tmpdir(), 'edne-cli-test-'));
const sourcePath = join(workDir, 'source');
const databasePath = join(workDir, 'dne.db');

beforeAll(async () => {
  createFixture(sourcePath, 20);
  const result = await runCli(['build', '--db', databasePath, '--source', sourcePath, '--quiet']);
  expect(result.status).toBe(0);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('CLI contract', () => {
  test('runs the executable entry point', () => {
    const result = spawnSync('bun', ['run', 'src/index.ts', '--version'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`dne ${packageJson.version}`);
  });

  test('uses the default Bun arguments and assigns the entry point exit code', async () => {
    const originalArgs = Bun.argv.splice(2, Bun.argv.length, '--version');
    const originalExitCode = process.exitCode;
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await import('../src/index.ts');
      expect(process.exitCode).toBe(0);
      expect(log).toHaveBeenCalledWith(`dne ${packageJson.version}`);
    } finally {
      Bun.argv.splice(2, Bun.argv.length, ...originalArgs);
      process.exitCode = originalExitCode;
      log.mockRestore();
    }
  });

  test('prints lookup results and reports missing or conflicting input', async () => {
    const found = await runCli(['get', '30000001', '--db', databasePath]);
    expect(found.status).toBe(0);
    expect(found.stdout).toContain('Municipio 1');
    const missing = await runCli(['get', '99999999', '--db', databasePath]);
    expect(missing.status).toBe(3);
    expect(missing.stderr).toContain('CEP não encontrado: 99999999');
    const batch = await runCli(['get', '30000001', '99999999', '--db', databasePath]);
    expect(batch.stdout).toContain('cep\tencontrado\tlogradouro\tbairro\tmunicípio\tuf');
    expect(batch.stdout).toContain('99999999\tnão');
    const empty = await runCli(['get', '--json'], '');
    expect(empty.status).toBe(2);
    expect(parseJson(empty.stderr).error.code).toBe('missing-input');
    const conflict = await runCli(['get', '30000001', '--json', '--jsonl']);
    expect(conflict.status).toBe(2);
    expect(parseJson(conflict.stderr).error.code).toBe('output-conflict');
    const sql = await runCli(['sql', 'SELECT 42 AS answer', '--db', databasePath]);
    expect(parseJson(sql.stdout).rows).toEqual([{ answer: 42 }]);
  });

  test('builds, updates, and inspects binary and in-memory databases', async () => {
    const target = join(workDir, 'direct-binary.bin');
    const built = await runCli(['build', '--format=binary', '--db', target, '--source', sourcePath]);
    expect(built.status).toBe(0);
    expect(built.stdout).toContain('Base criada:');
    const schema = await runCli(['schema', '--db', target, '--json']);
    expect(parseJson(schema.stdout).data.source).toBe('binary');
    const sql = await runCli(['sql', 'SELECT 1', '--db', target, '--json']);
    expect(sql.status).toBe(2);
    expect(parseJson(sql.stderr).error.code).toBe('sql-unsupported');
    const memory = await runCli(['build', '--db', ':memory:', '--source', sourcePath]);
    expect(memory.status).toBe(0);
    expect(memory.stdout).toContain('24 registros, tamanho desconhecido');
    const invalid = await runCli(['build', '--format=binary', '--db', ':memory:', '--json']);
    expect(invalid.status).toBe(2);
    expect(parseJson(invalid.stderr).error.code).toBe('invalid-format');
    const updateTarget = join(workDir, 'direct-update.db');
    copyFileSync(databasePath, updateTarget);
    const updated = await runCli(['build', '--db', updateTarget, '--source', sourcePath]);
    expect(updated.status).toBe(0);
    expect(updated.stdout).toContain('Base atualizada:');
  });

  test('reports unusable database files and missing setup in text', async () => {
    const small = join(workDir, 'invalid-small.db');
    writeFileSync(small, 'broken');
    const status = await runCli(['status', '--db', small]);
    expect(status.status).toBe(1);
    expect(status.stdout).toContain('6 B');
    expect(status.stdout).toContain('Erro:');
    const large = join(workDir, 'invalid-large.db');
    writeFileSync(large, Buffer.alloc(1024 * 1024 + 1, 1));
    expect((await runCli(['status', '--db', large])).stdout).toContain('1,0 MiB');
    const doctor = await runCli(['doctor', '--offline', '--db', join(workDir, 'setup.db')]);
    expect(doctor.status).toBe(1);
    expect(doctor.stdout).toContain('Configuração: Execute bunx');
  });

  test('cleans up failed imports and preserves an existing database on publication errors', async () => {
    const empty = join(workDir, 'empty-source');
    createFixture(empty, 0);
    const failure = await runCli(['build', '--db', join(workDir, 'empty.db'), '--source', empty, '--json']);
    expect(failure.status).toBe(1);
    expect(failure.stderr).toContain('source-quality-failed');
    const invalidSource = join(workDir, 'invalid.zip');
    writeFileSync(invalidSource, 'invalid ZIP');
    const zip = await runCli(['build', '--db', join(workDir, 'invalid.db'), '--source', invalidSource, '--json']);
    expect(zip.status).toBe(1);
    expect(zip.stderr).toContain('A fonte não é um arquivo ZIP válido');

    const updateTarget = join(workDir, 'failed-update.db');
    copyFileSync(databasePath, updateTarget);
    const run = Object.getOwnPropertyDescriptor(Database.prototype, 'run')?.value as Database['run'];
    const failureDuringPublish = spyOn(Database.prototype, 'run').mockImplementation(function(this: Database, sql, ...bindings) {
      if (sql.includes('INSERT INTO main.')) {
        throw new Error('simulated publication failure');
      }
      return run.call(this, sql, ...bindings);
    });
    try {
      const result = await runCli(['build', '--db', updateTarget, '--source', sourcePath, '--json']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('simulated publication failure');
    } finally {
      failureDuringPublish.mockRestore();
    }
    const lookup = await runCli(['get', '30000001', '--db', updateTarget, '--json']);
    expect(lookup.status).toBe(0);
    expect(parseJson(lookup.stdout).data.results[0].found).toBe(true);
  });

  test('formats stored SQL containing comments, nested expressions and escaped identifiers', async () => {
    const schema = spyOn(DneDatabaseReader.prototype, 'tableSchema').mockReturnValue(
      'CREATE TABLE dne ([cep] TEXT DEFAULT \'a,\'\'b\', -- comment,\n "extra" INTEGER CHECK (("extra") > 0))',
    );
    try {
      const result = await runCli(['schema', '--db', databasePath]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('[cep] TEXT DEFAULT \'a,\'\'b\'');
      expect(result.stdout).toContain('-- comment,');
      schema.mockReturnValue('CREATE TABLE dne AS SELECT 1');
      expect((await runCli(['schema', '--db', databasePath])).stdout).toContain('CREATE TABLE dne AS SELECT 1');
      schema.mockReturnValue('CREATE TABLE dne ()');
      expect((await runCli(['schema', '--db', databasePath])).stdout).toContain('CREATE TABLE dne ()');
    } finally {
      schema.mockRestore();
    }
    expect(renderSqlCodeBlock('SELECT \'literal\'', true)).toContain('\'literal\'');
  });

  test('checks remote updates and diagnoses unreachable sources', async () => {
    const fixture = Bun.file(createNestedZipFixture(join(workDir, 'direct-remote'), 20));
    let etag = '"v1"';
    let downloads = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === '/unavailable') {
          return new Response(null, { status: 503 });
        }
        if (request.method !== 'HEAD') {
          downloads++;
        }
        return new Response(request.method === 'HEAD' ? null : fixture, {
          headers: { etag, 'content-length': String(fixture.size), 'last-modified': 'Sun, 30 Aug 2026 07:00:00 GMT' },
        });
      },
    });
    const url = new URL('/dne.zip', server.url).href;
    const unavailableUrl = new URL('/unavailable', server.url).href;
    const target = join(workDir, 'direct-remote.db');
    try {
      expect((await runCli(['build', '--db', target, '--source', url])).status).toBe(0);
      expect(downloads).toBe(1);
      const unchanged = await runCli(['build', '--db', target, '--source', url]);
      expect(unchanged.stdout).toContain('A base DNE já está atualizada:');
      expect(downloads).toBe(1);
      const current = await runCli(['build', '--check', '--db', target, '--source', url]);
      expect(current.stdout).toContain('Estado: atualizada');
      etag = '"v2"';
      const stale = await runCli(['build', '--check', '--db', target, '--source', url]);
      expect(stale.stdout).toContain('Estado: atualização disponível');
      const healthy = await runCli(['doctor', '--db', target, '--source', url]);
      expect(healthy.status).toBe(0);
      expect(healthy.stdout).toContain('Fonte: acessível');
      const unhealthy = await runCli(['doctor', '--db', target, '--source', unavailableUrl, '--json']);
      expect(unhealthy.status).toBe(1);
      expect(parseJson(unhealthy.stdout).data.source).toMatchObject({ checked: true, reachable: false });
      const failed = await runCli(['build', '--check', '--db', target, '--source', unavailableUrl, '--json']);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain('source-unavailable');
    } finally {
      await server.stop(true);
    }
  });

  test('prints cron previews, updates, status and removal results', async () => {
    const target = join(workDir, 'text-cron.db');
    const env = { ...process.env, XDG_STATE_HOME: join(workDir, 'text-cron'), DNE_TEST_CRON_CALLS: join(workDir, 'text-cron.jsonl') };
    const missing = await runCliWithFakeCron(['cron', 'status', '--db', target], env);
    expect(missing.stdout).toContain('Nenhum agendamento instalado');
    const preview = await runCliWithFakeCron(['cron', 'install', '--dry-run', '--db', target], env);
    expect(preview.stdout).toContain('Agendamento que seria instalado');
    const installed = await runCliWithFakeCron(['cron', 'install', '--db', target], env);
    expect(installed.stdout).toContain('Agendamento instalado');
    const updated = await runCliWithFakeCron(['cron', 'install', '--db', target], env);
    expect(updated.stdout).toContain('Agendamento atualizado');
    const status = await runCliWithFakeCron(['cron', 'status', '--db', target], env);
    expect(status.stdout).toContain('Próxima execução:');
    const removed = await runCliWithFakeCron(['cron', 'remove', '--db', target], env);
    expect(removed.stdout).toContain('Agendamento removido');
    const absent = await runCliWithFakeCron(['cron', 'remove', '--db', target], env);
    expect(absent.stdout).toContain('Nenhum agendamento');
    const invalid = await runCli(['--invalid']);
    expect(invalid.status).toBe(2);
    expect(invalid.stderr).toContain('erro:');
  });

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

  test('shows the complete command surface and package version', async () => {
    const help = await runCli(['--help']);
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

    const version = await runCli(['--version']);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(`dne ${packageJson.version}`);
  });

  test('detects terminal colors when translated output writers are active', async () => {
    const colorEnvironment: Record<string, string | undefined> = {
      ...process.env,
      TERM: 'xterm-256color',
    };
    delete colorEnvironment['NO_COLOR'];

    const automatic = await runCliWithStdoutTty(['--help'], colorEnvironment);
    expect(automatic.status).toBe(0);
    expect(automatic.stdout).toContain('\x1b[');

    const disabled = await runCliWithStdoutTty(['--no-color', '--help'], colorEnvironment);
    expect(disabled.status).toBe(0);
    expect(disabled.stdout).not.toContain('\x1b[');

    const noColor = await runCliWithStdoutTty(['--help'], { ...colorEnvironment, NO_COLOR: '1' });
    expect(noColor.status).toBe(0);
    expect(noColor.stdout).not.toContain('\x1b[');
  });

  test('uses Bun.cron to install, report, update, and remove schedules', async () => {
    const cronCalls = join(workDir, 'bun-cron-calls.jsonl');
    const cronState = join(workDir, 'bun-cron-state');
    const cronEnvironment: Record<string, string | undefined> = {
      ...process.env,
      DNE_TEST_CRON_CALLS: cronCalls,
      XDG_STATE_HOME: cronState,
    };
    const target = join(workDir, 'cron % friday\'s.db');
    const scheduledSource = join(workDir, 'source % friday\'s.zip');

    const missing = await runCliWithFakeCron(['cron', 'status', '--db', target, '--json'], cronEnvironment);
    expect(missing.status).toBe(0);
    expect(parseJson(missing.stdout).data).toMatchObject({
      database: target,
      installed: false,
    });

    const preview = await runCliWithFakeCron(
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

    const installed = await runCliWithFakeCron(
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

    const updated = await runCliWithFakeCron(
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

    const status = await runCliWithFakeCron(['cron', 'status', '--db', target, '--json'], cronEnvironment);
    expect(status.status).toBe(0);
    expect(parseJson(status.stdout).data).toMatchObject({
      database: target,
      expression: '30 6 * * 5',
      installed: true,
      package_version: packageJson.version,
      source: scheduledSource,
    });

    const otherTarget = join(workDir, 'other-cron.db');
    const otherInstalled = await runCliWithFakeCron(
      ['cron', 'install', '--db', otherTarget, '--json'],
      cronEnvironment,
    );
    expect(otherInstalled.status).toBe(0);
    expect(parseJson(otherInstalled.stdout).data.title).not.toBe(installedData.title);

    const removed = await runCliWithFakeCron(['cron', 'remove', '--db', target, '--json'], cronEnvironment);
    expect(removed.status).toBe(0);
    expect(parseJson(removed.stdout).data.removed).toBe(true);
    expect(existsSync(installedData.runner)).toBe(false);
    expect(readCronCalls(cronCalls).at(-1)).toMatchObject({
      action: 'remove',
      title: installedData.title,
    });

    const removedAgain = await runCliWithFakeCron(['cron', 'remove', '--db', target, '--json'], cronEnvironment);
    expect(removedAgain.status).toBe(0);
    expect(parseJson(removedAgain.stdout).data.removed).toBe(false);

    const otherRemoved = await runCliWithFakeCron(
      ['cron', 'remove', '--db', otherTarget, '--json'],
      cronEnvironment,
    );
    expect(otherRemoved.status).toBe(0);
    expect(existsSync(parseJson(otherInstalled.stdout).data.runner)).toBe(false);

    const invalid = await runCliWithFakeCron(['cron', 'install', 'not cron', '--json'], cronEnvironment);
    expect(invalid.status).toBe(2);
    expect(parseJson(invalid.stderr.slice(invalid.stderr.indexOf('{'))).error.message).toContain('expressão cron válida');
  });

  test('returns a stable JSON get envelope', async () => {
    const current = await runCli(['get', '30000-001', '--db', databasePath, '--json']);
    expect(current.status).toBe(0);
    const currentJson = parseJson(current.stdout);
    expect(currentJson.ok).toBe(true);
    expect(currentJson.data.results[0]).toMatchObject({ cep: '30000001', found: true });
  });

  test('keeps get read-only and does not create a missing database', async () => {
    const missingPath = join(workDir, 'missing.db');
    const result = await runCli(['get', '30000001', '--db', missingPath, '--json']);
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

  test('distinguishes invalid CEP input from a valid missing CEP', async () => {
    const invalid = await runCli(['get', 'abc', '--db', databasePath, '--json']);
    expect(invalid.status).toBe(2);
    expect(parseJson(invalid.stderr).error.code).toBe('invalid-cep');
    expect(parseJson(invalid.stderr).error.message).toContain('CEP inválido');

    const invalidText = await runCli(['get', 'abc']);
    expect(invalidText.status).toBe(2);
    expect(invalidText.stderr).toContain('erro: CEP inválido');
    expect(invalidText.stderr).not.toContain('Usage:');

    const legacyDatabase = await runCli(['get', databasePath, '30000001', '--json']);
    expect(legacyDatabase.status).toBe(2);
    expect(parseJson(legacyDatabase.stderr).error.code).toBe('invalid-cep');

    const missing = await runCli(['get', '99999999', '--db', databasePath, '--json']);
    expect(missing.status).toBe(3);
    expect(parseJson(missing.stdout).data.results[0]).toMatchObject({
      cep: '99999999',
      found: false,
    });
  });

  test('reports invalid CEPs after valid inputs in a batch', async () => {
    const result = await runCli(['get', '30000001', 'abc', '--db', databasePath, '--json']);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(parseJson(result.stderr)).toMatchObject({
      ok: false,
      error: { code: 'invalid-cep', details: { input: 'abc' } },
    });
  });

  test('supports JSONL bulk input from arguments, files, and stdin', async () => {
    const argumentsResult = await runCli([
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
    const fileResult = await runCli(['get', '--file', inputPath, '--db', databasePath, '--jsonl']);
    expect(fileResult.status).toBe(0);
    expect(parseJsonLines(fileResult.stdout).map((value) => value.data.result.cep)).toEqual(['30000001', '30000002']);

    const stdinResult = await runCli(['get', '--db', databasePath, '--jsonl'], '30000001\n30000002\n');
    expect(stdinResult.status).toBe(0);
    expect(parseJsonLines(stdinResult.stdout)).toHaveLength(2);
  });

  test('reports status, actual schema, expected schema, and offline doctor state', async () => {
    const status = await runCli(['--json', 'status', '--db', databasePath]);
    expect(status.status).toBe(0);
    expect(parseJson(status.stdout).data).toMatchObject({ ready: true, row_count: 24 });

    const statusText = await runCli(['status', '--db', databasePath]);
    expect(statusText.status).toBe(0);
    expect(statusText.stdout).toMatch(/Tamanho: \d+,\d KiB/);
    expect(statusText.stdout).toMatch(/Carregada em: \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}/);
    expect(statusText.stdout).toContain(`Pacote: @konstit/dne@${packageJson.version}`);
    expect(statusText.stdout).toContain('Última modificação da fonte: -');

    const schema = await runCli(['schema', '--db', databasePath, '--json']);
    expect(schema.status).toBe(0);
    expect(parseJson(schema.stdout).data).toMatchObject({ source: 'database', table: 'dne' });

    const schemaText = await runCli(['schema', '--db', databasePath]);
    expect(schemaText.status).toBe(0);
    expect(schemaText.stdout).toContain(
      'CREATE TABLE "dne" (\n  "cep" TEXT NOT NULL /* Contém somente os oito dígitos do CEP, sem separadores. */,\n',
    );
    expect(schemaText.stdout).toContain('\n  PRIMARY KEY ("cep")\n) WITHOUT ROWID');

    const expected = await runCli(['schema', '--expected', '--json']);
    expect(expected.status).toBe(0);
    expect(parseJson(expected.stdout).data).toMatchObject({ source: 'declared', table: 'dne' });
    expect(parseJson(expected.stdout).data.sql).toContain('oito dígitos do CEP, sem separadores');

    const colorEnvironment = { ...process.env };
    delete colorEnvironment['NO_COLOR'];
    const colored = await runCli(['schema', '--expected', '--color'], undefined, colorEnvironment);
    expect(colored.status).toBe(0);
    expect(colored.stdout).toContain('\x1b[1mCREATE\x1b[0m');

    const plain = await runCli(['schema', '--expected', '--no-color']);
    expect(plain.status).toBe(0);
    expect(plain.stdout).not.toContain('\x1b[');

    const doctor = await runCli(['doctor', '--offline', '--db', databasePath, '--json']);
    expect(doctor.status).toBe(0);
    expect(parseJson(doctor.stdout).data).toMatchObject({
      auth: { required: false, source: 'not-required' },
      healthy: true,
      runtime: { compatible: true, name: 'bun' },
    });

    const doctorText = await runCli(['doctor', '--offline', '--db', databasePath]);
    expect(doctorText.status).toBe(0);
    expect(doctorText.stdout).toContain('Ambiente: bun');
    expect(doctorText.stdout).toContain('Base: pronta');
    expect(doctorText.stdout).toContain('Fonte: não verificada');
    expect(doctorText.stdout).toContain('Saudável: sim');

    const missingDoctor = await runCli([
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

  test('returns a JSON build summary and keeps progress on stderr', async () => {
    const target = join(workDir, 'build-summary.db');
    const result = await runCli(['build', '--db', target, '--source', sourcePath, '--json']);
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

    const check = await runCli(['build', '--check', '--db', target, '--source', sourcePath, '--json']);
    expect(check.status).toBe(0);
    expect(parseJson(check.stdout).data.status).toBe('unknown');

    const checkOnlyTarget = join(workDir, 'check-only.db');
    const checkOnly = await runCli(['build', '--check', '--db', checkOnlyTarget, '--source', sourcePath, '--json']);
    expect(checkOnly.status).toBe(0);
    expect(existsSync(temporaryFetchLockPath(checkOnlyTarget))).toBe(false);

    const missingSource = await runCli([
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

  test('recovers a lock left by a process that no longer exists', async () => {
    const target = join(workDir, 'stale-lock.db');
    const lockPath = temporaryFetchLockPath(target);
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      join(lockPath, 'owner.json'),
      JSON.stringify({ pid: 2_147_483_647, token: 'stale-owner' }),
    );

    const result = await runCli(['build', '--db', target, '--source', sourcePath, '--quiet']);

    expect(result.status).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('supports bounded read-only SQL and rejects write commands', async () => {
    const read = await runCli([
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

    const write = await runCli(['sql', 'DELETE FROM dne', '--db', databasePath, '--json']);
    expect(write.status).toBe(2);
    expect(parseJson(write.stderr).error.code).toBe('write-query-denied');
  });

  test('returns machine-readable parser failures under --json', async () => {
    const result = await runCli(['build', '--force', '--check', '--json']);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(parseJson(result.stderr)).toMatchObject({
      ok: false,
      error: { code: 'invalid-arguments' },
    });

    const coloredJsonError = await runCli(['--color', 'build', '--force', '--check', '--json']);
    expect(coloredJsonError.status).toBe(2);
    expect(coloredJsonError.stderr).not.toContain('\x1b[');
    expect(parseJson(coloredJsonError.stderr).error.message).not.toContain('erro:');

    const positionalDatabase = await runCli(['build', './legacy.db', '--json']);
    expect(positionalDatabase.status).toBe(2);
    expect(parseJson(positionalDatabase.stderr)).toMatchObject({
      ok: false,
      error: { code: 'invalid-arguments' },
    });

    for (const retiredCommand of ['fetch', 'lookup']) {
      const retired = await runCli([retiredCommand, '--json']);
      expect(retired.status).toBe(2);
      expect(parseJson(retired.stderr)).toMatchObject({
        ok: false,
        error: { code: 'invalid-arguments' },
      });
    }
  });
});

async function runCli(args: string[], input?: string, env = process.env, tty = false) {
  let stdout = '';
  let stderr = '';
  const originalEnvironment = { ...process.env };
  const originalStdin = Bun.stdin;
  const streams = [process.stdin, process.stdout, process.stderr];
  const ttyDescriptors = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
  const inputPath = join(workDir, 'stdin.txt');
  writeFileSync(inputPath, input ?? '');
  Object.assign(Bun, { stdin: Bun.file(inputPath) });
  for (const stream of streams) {
    Object.defineProperty(stream, 'isTTY', { configurable: true, value: tty });
  }
  for (const key of new Set([...Object.keys(process.env), ...Object.keys(env)])) {
    if (env[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = env[key];
    }
  }
  const log = spyOn(console, 'log').mockImplementation((...values) => {
    stdout += `${format(...values)}\n`;
  });
  const error = spyOn(console, 'error').mockImplementation((...values) => {
    stderr += `${format(...values)}\n`;
  });
  const out = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const err = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  try {
    const status = await executeCli(args);
    return { status, stdout, stderr };
  } finally {
    log.mockRestore();
    error.mockRestore();
    out.mockRestore();
    err.mockRestore();
    Object.assign(Bun, { stdin: originalStdin });
    for (const [index, stream,] of streams.entries()) {
      const descriptor = ttyDescriptors[index];
      if (descriptor) {
        Object.defineProperty(stream, 'isTTY', descriptor);
      } else {
        Reflect.deleteProperty(stream, 'isTTY');
      }
    }
    for (const key of new Set([...Object.keys(process.env), ...Object.keys(originalEnvironment)])) {
      if (originalEnvironment[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnvironment[key];
      }
    }
  }
}

function runCliWithStdoutTty(args: string[], env = process.env) {
  return runCli(args, undefined, env, true);
}

async function runCliWithFakeCron(args: string[], env = process.env) {
  const originalCron = Bun.cron;
  const callsPath = env['DNE_TEST_CRON_CALLS'];
  if (!callsPath) {
    throw new Error('Missing cron call log path');
  }
  const record = (value: unknown) => appendFileSync(callsPath, `${JSON.stringify(value)}\n`);
  const cron = async (path: string, schedule: string, title: string) => record({ action: 'install', path, schedule, title });
  cron.parse = originalCron.parse.bind(originalCron);
  cron.remove = async (title: string) => record({ action: 'remove', title });
  Object.assign(Bun, { cron });
  try {
    return await runCli(args, undefined, env);
  } finally {
    Object.assign(Bun, { cron: originalCron });
  }
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
