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
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import packageJson from '../package.json';
import { createFixture } from './helpers.ts';

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

  test('returns a stable JSON lookup envelope and accepts the legacy syntax', () => {
    const current = runCli(['lookup', '30000-001', '--db', databasePath, '--json']);
    expect(current.status).toBe(0);
    const currentJson = parseJson(current.stdout);
    expect(currentJson.ok).toBe(true);
    expect(currentJson.data.results[0]).toMatchObject({ cep: '30000001', found: true });

    const legacy = runCli(['lookup', databasePath, '30000001', '--json']);
    expect(legacy.status).toBe(0);
    expect(parseJson(legacy.stdout).data.results[0].address.uf).toBe('BA');
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
    expect(parseJson(invalid.stderr).error.code).toBe('invalid-cep');

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

    const schema = runCli(['schema', '--db', databasePath, '--json']);
    expect(schema.status).toBe(0);
    expect(parseJson(schema.stdout).data).toMatchObject({ source: 'database', table: 'dne' });

    const expected = runCli(['schema', '--expected', '--json']);
    expect(expected.status).toBe(0);
    expect(parseJson(expected.stdout).data).toMatchObject({ source: 'declared', table: 'dne' });

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
      database: { path: target, ready: true, row_count: 24 },
      source: { kind: 'local' },
      status: 'created',
    });
    expect(result.stderr).toContain('Reading directory source');
    expect(result.stderr).toContain('Loading streets');
    expect(result.stderr).toContain('Committing the database');

    const check = runCli(['fetch', '--check', '--db', target, '--source', sourcePath, '--json']);
    expect(check.status).toBe(0);
    expect(parseJson(check.stdout).data.status).toBe('unknown');
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
  });
});

function runCli(args: string[], input?: string) {
  return spawnSync('bun', ['run', 'src/index.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    input,
  });
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
