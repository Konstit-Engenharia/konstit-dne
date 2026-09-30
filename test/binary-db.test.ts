import { Database } from 'bun:sqlite';
import {
  afterAll,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  BINARY_SECTION_NAMES,
  SECTION_TABLE_OFFSET,
} from '../src/binary-db-format.ts';
import { DneBinaryDatabaseReader } from '../src/binary-db-reader.ts';
import { buildBinaryDatabase } from '../src/binary-db-writer.ts';
import {
  hasTable,
  inspectDatabase,
  openReadyDatabase,
  readDatabaseMetadata,
} from '../src/database-service.ts';
import { DneDatabaseReader } from '../src/db.ts';
import { captureRejection } from './assertions.ts';
import {
  createFixture,
  createLocalityFixture,
  fetchDatabase,
  run,
} from './helpers.ts';

const workDir = mkdtempSync(join('/tmp', 'dne-binary-test-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('binary database', () => {
  test('exports interned SoA data and looks it up through mmap', async () => {
    const sourcePath = join(workDir, 'source');
    const sqlitePath = join(workDir, 'source.db');
    const binaryPath = join(workDir, 'source.bin');
    createFixture(sourcePath, 40);
    fetchDatabase(sqlitePath, sourcePath);

    const sqliteReader = new DneDatabaseReader(sqlitePath);
    try {
      expect(sqliteReader.queryCep('30000-001')?.cep).toBe('30000001');
      expect(sqliteReader.queryCep('3000A001')).toBeUndefined();
      expect(sqliteReader.queryCep('99999999')).toBeUndefined();
    } finally {
      sqliteReader.close();
    }

    await buildBinaryDatabase(sqlitePath, binaryPath);
    expect(await readDatabaseMetadata(binaryPath)).toMatchObject({ source_kind: 'local' });
    expect(await hasTable(binaryPath, 'dne')).toBe(true);
    expect(await hasTable(binaryPath, 'missing')).toBe(false);
    expect(await captureRejection(openReadyDatabase(binaryPath, 'missing'))).toMatchObject({ code: 'database-not-ready' });
    const reader = new DneBinaryDatabaseReader(binaryPath);
    try {
      expect(reader.rowCount()).toBe(47);
      expect(reader.queryCep('30000001')).toEqual({
        bairro: 'Bairro 1',
        cep: '30000001',
        complemento: null,
        localidade_situacao: 'codificada_por_logradouro',
        localidade_tipo: 'municipio',
        logradouro: 'Rua Endereco 1',
        municipio: 'Municipio 1',
        municipio_cod_ibge: 3500001,
        nome: null,
        uf: 'BA',
      });
      expect(reader.queryCep('30000-001')?.cep).toBe('30000001');
      expect(reader.queryCep('99999999')).toBeUndefined();
      expect(reader.queryCep('3000A001')).toBeUndefined();
      expect(reader.metadata()).toMatchObject({ source_kind: 'local' });

      expectAllRowsMatch(reader, sqlitePath);
    } finally {
      reader.close();
    }

    expect(statSync(binaryPath).size).toBeLessThan(statSync(sqlitePath).size);
  });

  test('decodes front-coded dictionaries and sparse columns across block boundaries', async () => {
    const sourcePath = join(workDir, 'block-source');
    const sqlitePath = join(workDir, 'block-source.db');
    const binaryPath = join(workDir, 'block-source.bin');
    createFixture(sourcePath, 300);
    fetchDatabase(sqlitePath, sourcePath);

    await buildBinaryDatabase(sqlitePath, binaryPath);
    const reader = new DneBinaryDatabaseReader(binaryPath);
    try {
      expect(reader.rowCount()).toBe(349);
      expectAllRowsMatch(reader, sqlitePath);
    } finally {
      reader.close();
    }
  });

  test('retains municipality, district and village indicators through binary export', async () => {
    const sourcePath = join(workDir, 'localities');
    const sqlitePath = join(workDir, 'localities.db');
    const binaryPath = join(workDir, 'localities.bin');
    createLocalityFixture(sourcePath);
    fetchDatabase(sqlitePath, sourcePath);
    await buildBinaryDatabase(sqlitePath, binaryPath);
    const bytes = new Uint8Array(await Bun.file(binaryPath).arrayBuffer());
    const directoryOffset = SECTION_TABLE_OFFSET + BINARY_SECTION_NAMES.indexOf('localidadeFlags') * 8;
    const flagsOffset = new DataView(bytes.buffer).getUint32(directoryOffset, true);
    expect([...bytes.subarray(flagsOffset, flagsOffset + 8)]).toEqual([0, 4, 3, 7, 11, 1, 10, 5]);
    const reader = new DneBinaryDatabaseReader(binaryPath);
    try {
      expectAllRowsMatch(reader, sqlitePath);
      expect(reader.queryCep('10000000')).toMatchObject({
        localidade_situacao: 'sem_codificacao_por_logradouro',
        localidade_tipo: 'municipio',
      });
      expect(reader.queryCep('11000000')).toMatchObject({
        localidade_situacao: 'sem_codificacao_por_logradouro',
        localidade_tipo: 'distrito',
      });
      expect(reader.queryCep('64000000')).toMatchObject({
        localidade_situacao: 'inserida_na_codificacao_por_logradouro',
        localidade_tipo: 'povoado',
        municipio: 'Municipio Codificado',
      });
      for (const [cep, tipo,] of [['12000000', 'municipio'], ['13000000', 'distrito'], ['14000000', 'povoado']] as const) {
        expect(reader.queryCep(cep)).toMatchObject({
          localidade_situacao: 'em_codificacao_por_logradouro',
          localidade_tipo: tipo,
          municipio: 'Municipio em Codificacao',
          municipio_cod_ibge: 3500006,
        });
      }
    } finally {
      reader.close();
    }
  });

  test('rejects unsupported binary versions and corrupt locality indicators', async () => {
    const sourcePath = join(workDir, 'invalid-localities');
    const sqlitePath = join(workDir, 'invalid-localities.db');
    const binaryPath = join(workDir, 'invalid-localities.bin');
    createLocalityFixture(sourcePath);
    fetchDatabase(sqlitePath, sourcePath);
    await buildBinaryDatabase(sqlitePath, binaryPath);
    const original = new Uint8Array(await Bun.file(binaryPath).arrayBuffer());

    const oldVersion = original.slice();
    new DataView(oldVersion.buffer).setUint16(8, 2, true);
    const oldPath = join(workDir, 'old-version.bin');
    await Bun.write(oldPath, oldVersion);
    expect(() => new DneBinaryDatabaseReader(oldPath)).toThrow('build --force');

    const directoryOffset = SECTION_TABLE_OFFSET + BINARY_SECTION_NAMES.indexOf('localidadeFlags') * 8;
    const flagsOffset = new DataView(original.buffer).getUint32(directoryOffset, true);
    for (const flag of [12, 15, 16, 255]) {
      const corrupted = original.slice();
      corrupted[flagsOffset] = flag;
      const path = join(workDir, `invalid-flag-${flag}.bin`);
      await Bun.write(path, corrupted);
      const reader = new DneBinaryDatabaseReader(path);
      try {
        expect(() => reader.queryCep('10000000')).toThrow('Invalid binary locality indicators');
      } finally {
        reader.close();
      }
    }

    const truncated = original.slice();
    new DataView(truncated.buffer).setUint32(directoryOffset + 4, 0, true);
    const truncatedPath = join(workDir, 'truncated-flags.bin');
    await Bun.write(truncatedPath, truncated);
    expect(() => new DneBinaryDatabaseReader(truncatedPath)).toThrow('locality indicators region has an invalid length');
  });

  test('CLI creates and detects a binary database', async () => {
    const sourcePath = join(workDir, 'cli-source');
    const binaryPath = join(workDir, 'cli.bin');
    createFixture(sourcePath, 20);
    run('bun', [
      'run',
      'src/index.ts',
      'build',
      '--quiet',
      '--format',
      'binary',
      '--db',
      binaryPath,
      '--source',
      sourcePath,
    ]);

    expect(await inspectDatabase(binaryPath)).toMatchObject({
      exists: true,
      format: 'binary',
      ready: true,
      row_count: 24,
      schema: null,
    });

    const reader = await openReadyDatabase(binaryPath);
    try {
      expect(reader.queryCep('30000001')?.municipio).toBe('Municipio 1');
    } finally {
      reader.close();
    }
  });

  test.each(
    [
      [undefined, 'dne.bin'],
      ['custom.db', 'custom.bin'],
      ['custom', 'custom.bin'],
      ['custom.bin', 'custom.bin'],
    ] as const,
  )('CLI uses a .bin extension for database path %s', async (database, filename) => {
    const directory = mkdtempSync(join(workDir, 'extension-'));
    const sourcePath = join(directory, 'source');
    const sqlitePath = join(directory, database === 'custom.db' ? database : 'dne.db');
    createFixture(sourcePath, 20);
    fetchDatabase(sqlitePath, sourcePath);

    run('bun', [
      'run',
      join(process.cwd(), 'src/index.ts'),
      'build',
      '--format=binary',
      '--source',
      sourcePath,
      '--quiet',
      ...(database ? ['--db', database] : []),
    ], directory);

    const binaryPath = join(directory, filename);
    expect(await inspectDatabase(binaryPath)).toMatchObject({ format: 'binary', ready: true, row_count: 24 });
    expect(await inspectDatabase(sqlitePath)).toMatchObject({ format: 'sqlite', ready: true, row_count: 24 });
    run('bun', [
      'run',
      join(process.cwd(), 'src/index.ts'),
      'get',
      '30000001',
      '--db',
      binaryPath,
    ], directory);
  });
});

function expectAllRowsMatch(reader: DneBinaryDatabaseReader, sqlitePath: string) {
  const sqlite = new Database(sqlitePath, { readonly: true });
  const sqliteReader = new DneDatabaseReader(sqlitePath);
  try {
    const rows = sqlite.query('SELECT cep FROM dne_consulta ORDER BY cep').all() as { cep: string; }[];
    for (const { cep } of rows) {
      expect(reader.queryCep(cep)).toEqual(sqliteReader.queryCep(cep));
    }
  } finally {
    sqliteReader.close();
    sqlite.close();
  }
}
