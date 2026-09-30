import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalityFixture } from './helpers.ts';

const root = process.cwd();
const workDir = mkdtempSync(join(tmpdir(), 'dne-package-'));
const checkout = join(workDir, 'checkout');
const consumer = join(workDir, 'consumer with spaces');
const installed = join(consumer, 'node_modules/@konstit/dne');
const otherCwd = join(consumer, 'other directory');
let packedFiles: string[];

beforeAll(() => {
  mkdirSync(checkout, { recursive: true });
  for (const path of ['package.json', 'tsconfig.json', 'tsconfig.build.json', 'src', 'scripts']) {
    cpSync(join(root, path), join(checkout, path), { recursive: true });
  }
  symlinkSync(join(root, 'node_modules'), join(checkout, 'node_modules'), 'dir');
  const source = join(workDir, 'source');
  createLocalityFixture(source);
  const output = run('npm', ['pack', '--json', '--pack-destination', workDir], checkout, { ...process.env, DNE_PACKAGE_SOURCE: source });
  const [packed,] = JSON.parse(output) as { filename: string; files: { path: string; }[]; }[];
  if (!packed) {
    throw new Error('npm pack did not produce a tarball');
  }
  packedFiles = packed.files.map((file) => file.path);
  mkdirSync(installed, { recursive: true });
  run('tar', ['-xzf', join(workDir, packed.filename), '--strip-components=1', '-C', installed], workDir);
  mkdirSync(join(consumer, 'node_modules/.bin'), { recursive: true });
  symlinkSync('../@konstit/dne/dist/index.js', join(consumer, 'node_modules/.bin/dne'));
  chmodSync(join(installed, 'dist/index.js'), 0o755);
  mkdirSync(otherCwd, { recursive: true });
  writeFileSync(join(consumer, 'package.json'), '{"type":"module"}');
  writeFileSync(join(otherCwd, 'dne.bin'), 'This must not be used as the default database');
}, 30_000);

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe('published package', () => {
  test('packs the database, JavaScript, and declarations without source files or SQLite data', () => {
    expect(packedFiles).toContain('data/dne.bin');
    expect(packedFiles).toContain('dist/library.js');
    expect(packedFiles).toContain('dist/library.d.ts');
    expect(packedFiles).toContain('dist/binary-db-reader.d.ts');
    expect(packedFiles).toContain('dist/sqlite-db-reader.d.ts');
    expect(packedFiles).toContain('dist/sqlite-db-errors.d.ts');
    expect(packedFiles).toContain('dist/index.js');
    expect(packedFiles.some((path) => path.startsWith('src/') || path.endsWith('.db'))).toBe(false);
  });

  test('imports silently and reads the bundled database independently of the working directory', () => {
    const output = run('bun', [
      '--eval',
      `
      import { DneBinaryDatabaseReader, DneBinaryDatabaseClosedError, DneBinaryDatabaseIOError } from '@konstit/dne';
      import { DneDatabaseReader, DneDatabaseClosedError, DneDatabaseIOError } from '@konstit/dne';
      import { Database } from 'bun:sqlite';
      import { strict as assert } from 'node:assert';
      assert.equal(process.exitCode, undefined);
      const reader = new DneBinaryDatabaseReader();
      assert.equal(reader.rowCount(), 20);
      assert.equal(reader.queryCep('21000000').bairro, 'Centro');
      assert.equal(reader.queryCep('21000000').localidade_tipo, 'municipio');
      assert.equal(reader.queryCep('21000000').localidade_situacao, 'codificada_por_logradouro');
      assert.equal(reader.queryCep('13000000').localidade_tipo, 'distrito');
      assert.equal(reader.queryCep('13000000').localidade_situacao, 'em_codificacao_por_logradouro');
      assert.equal(reader.queryNeighborhoodByCep('21000000').bairro_id, 11);
      assert.equal(reader.queryNeighborhoodCepRanges(11).length, 2);
      reader.close();
      assert.throws(() => reader.queryCep('21000000'), DneBinaryDatabaseClosedError);
      assert.throws(() => new DneBinaryDatabaseReader('./missing.bin'), DneBinaryDatabaseIOError);
      const sqlite = new Database('./reader.db');
      sqlite.run('CREATE TABLE sample (value INTEGER); INSERT INTO sample VALUES (42)');
      sqlite.close();
      const sqliteReader = new DneDatabaseReader('./reader.db');
      try {
        assert.equal(sqliteReader.rowCount('sample'), 1);
        assert.deepEqual(sqliteReader.querySql('SELECT * FROM sample', 10), {
          rows: [{ value: 42 }], truncated: false,
        });
      } finally {
        sqliteReader.close();
      }
      assert.throws(() => sqliteReader.rowCount('sample'), DneDatabaseClosedError);
      assert.throws(() => new DneDatabaseReader('./missing.db'), DneDatabaseIOError);
      console.log('library-ok');
    `,
    ], otherCwd);
    expect(output.trim()).toBe('library-ok');
  });

  test('retains the CLI executable and its Bun shebang', () => {
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as { bin: { dne: string; }; version: string; };
    const entrypoint = join(installed, manifest.bin.dne);
    expect(readFileSync(entrypoint, 'utf8').startsWith('#!/usr/bin/env bun')).toBe(true);
    expect(run('bun', [entrypoint, '--version'], otherCwd).trim()).toBe(`dne ${manifest.version}`);
    expect(run('bunx', ['--no-install', '@konstit/dne', '--version'], otherCwd).trim()).toBe(`dne ${manifest.version}`);
    expect(run('bun', [entrypoint, '--help'], otherCwd)).toContain('build');
  });

  test.each(['NodeNext', 'Bundler'])('resolves public TypeScript declarations with %s', (resolution) => {
    writeFileSync(
      join(consumer, 'consumer.ts'),
      `
      import {
        DneBinaryDatabaseReader, DneBinaryDatabaseError, DneBinaryDatabaseClosedError,
        DneBinaryDatabaseIOError, DneBinaryDatabaseFormatError, DneBinaryDatabaseVersionError,
        DneDatabaseReader, DneDatabaseError, DneDatabaseClosedError, DneDatabaseIOError,
        DneDatabaseSchemaError, DneDatabaseDataError, DneDatabaseQueryError, type DneDatabaseErrorCode,
        type DneRow, type DneBairro, type DneFaixaCep, type LoadMetadata, type UF,
        type LocalidadeTipo, type LocalidadeSituacao, type DneBinaryDatabaseErrorCode,
      } from '@konstit/dne';
      const reader = new DneBinaryDatabaseReader();
      const row: DneRow | undefined = reader.queryCep('21000000');
      const bairro: DneBairro | undefined = reader.queryNeighborhoodByCep('21000000');
      const neighborhood: DneBairro | undefined = reader.queryNeighborhood(11);
      const rowUf: UF | undefined = row?.uf;
      const bairroUf: UF | undefined = bairro?.uf;
      // @ts-expect-error Address UFs must be supported Brazilian state abbreviations.
      const invalidRowUf: DneRow['uf'] = 'XX';
      // @ts-expect-error Neighborhood UFs must be supported Brazilian state abbreviations.
      const invalidBairroUf: DneBairro['uf'] = 'XX';
      const ranges: DneFaixaCep[] = reader.queryNeighborhoodCepRanges(11);
      const metadata: LoadMetadata = reader.metadata();
      const tipo: LocalidadeTipo | undefined = row?.localidade_tipo;
      const situacao: LocalidadeSituacao | undefined = row?.localidade_situacao;
      const tipos: LocalidadeTipo[] = ['municipio', 'distrito', 'povoado'];
      const situacoes: LocalidadeSituacao[] = [
        'sem_codificacao_por_logradouro', 'codificada_por_logradouro',
        'inserida_na_codificacao_por_logradouro', 'em_codificacao_por_logradouro',
      ];
      // @ts-expect-error Original DNE codes are not public locality types.
      const tipoCodigo: LocalidadeTipo = 'M';
      // @ts-expect-error Original DNE status numbers are not public coding statuses.
      const situacaoCodigo: LocalidadeSituacao = 3;
      // @ts-expect-error Locality types are a closed string union.
      const tipoDesconhecido: LocalidadeTipo = 'outro';
      // @ts-expect-error Coding statuses are a closed string union.
      const situacaoDesconhecida: LocalidadeSituacao = 'outra';
      const error: DneBinaryDatabaseError = new DneBinaryDatabaseClosedError();
      const code: DneBinaryDatabaseErrorCode = error.code;
      new DneBinaryDatabaseIOError('missing');
      new DneBinaryDatabaseFormatError('invalid');
      new DneBinaryDatabaseVersionError(2, 1);
      const sqliteReader = new DneDatabaseReader('./dne.db');
      const sqliteRow: DneRow | undefined = sqliteReader.queryCep('21000000');
      const sqliteBairro: DneBairro | undefined = sqliteReader.queryNeighborhoodByCep('21000000');
      const sqliteNeighborhood: DneBairro | undefined = sqliteReader.queryNeighborhood(11);
      const sqliteMetadata: LoadMetadata | undefined = sqliteReader.metadata();
      const sqliteSchema: string | undefined = sqliteReader.tableSchema('dne');
      const sqliteError: DneDatabaseError = new DneDatabaseClosedError();
      const sqliteCode: DneDatabaseErrorCode = sqliteError.code;
      new DneDatabaseIOError('missing');
      new DneDatabaseSchemaError('invalid schema');
      new DneDatabaseDataError('invalid data');
      new DneDatabaseQueryError('invalid query');
      sqliteReader.close();
      // @ts-expect-error CEP lookups require a string.
      reader.queryCep(21000000);
      // @ts-expect-error Original neighborhood identifiers are numeric.
      reader.queryNeighborhood('11');
      // @ts-expect-error Endpoints retain their leading zeroes as strings.
      const endpoint: number = ranges[0].cep_inicial;
      void [row, bairro, ranges, metadata, tipo, situacao, tipos, situacoes, tipoCodigo, situacaoCodigo,
        tipoDesconhecido, situacaoDesconhecida, code, endpoint, rowUf, bairroUf, invalidRowUf, invalidBairroUf,
        neighborhood, sqliteRow, sqliteBairro, sqliteNeighborhood, sqliteMetadata, sqliteSchema, sqliteCode];
      reader.close();
    `,
    );
    writeFileSync(
      join(consumer, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: resolution === 'NodeNext' ? 'NodeNext' : 'ESNext',
          moduleResolution: resolution,
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: [],
        },
        files: ['consumer.ts'],
      }),
    );
    run('bun', [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')], otherCwd);
  });
});

function run(command: string, args: string[], cwd: string, env = process.env): string {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr}\n${result.stdout}`);
  }
  return result.stdout;
}
