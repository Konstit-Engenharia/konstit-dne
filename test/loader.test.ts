import { Database } from 'bun:sqlite';
import {
  afterAll,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTableSql,
  DneDatabaseReader,
  DneDatabaseWriter,
  type LoadQualityReport,
} from '../src/db.ts';
import { DirectoryDneSource } from '../src/dne-source.ts';
import {
  buildSchema,
  getUnifiedTable,
} from '../src/schema.ts';
import { SQLITE_CEP_TABLE_NAME } from '../src/settings.ts';
import { captureRejection } from './assertions.ts';
import {
  createFixture,
  createLocalityFixture,
  createNestedZipFixture,
  fetchDatabase,
} from './helpers.ts';

const workDir = mkdtempSync(join(tmpdir(), 'edne-loader-test-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('loader', () => {
  test('loads a special address without a comma or complement', async () => {
    const directory = join(workDir, 'address-without-complement');
    createLocalityFixture(directory);
    replaceDelimitedField(join(directory, 'Delimitado', 'LOG_GRANDE_USUARIO.TXT'), 0, 6, ' Rua Central ');
    const path = join(directory, 'dne.db');
    const writer = new DneDatabaseWriter(path, buildSchema({ cep_unificado: SQLITE_CEP_TABLE_NAME }));
    try {
      expect(await writer.loadFromSource(new DirectoryDneSource(join(directory, 'Delimitado')))).toBe(20);
    } finally {
      writer.close();
    }
    using reader = new DneDatabaseReader(path);
    expect(reader.queryCep('52000000')).toMatchObject({ logradouro: 'Rua Central', complemento: null });
  });

  test('loads buffered source text with CRLF, empty lines, and an unterminated final record', async () => {
    const directory = join(workDir, 'buffered-source');
    createLocalityFixture(directory);
    const delimited = join(directory, 'Delimitado');
    const source = new DirectoryDneSource(delimited);
    const target = join(workDir, 'buffered.db');
    const writer = new DneDatabaseWriter(target, buildSchema({ cep_unificado: SQLITE_CEP_TABLE_NAME }));
    try {
      expect(
        await writer.loadFromSource({
          matchingFiles: source.matchingFiles.bind(source),
          readLines: source.readLines.bind(source),
          readText: async (file) => `\n\r\n${readFileSync(join(delimited, file), 'latin1').replaceAll('\n', '\r\n')}`,
        }),
      ).toBe(20);
    } finally {
      writer.close();
    }
    const reader = new DneDatabaseReader(target);
    try {
      expect(reader.queryCep('21000000')?.logradouro).toBe('Rua Principal');
      expect(reader.queryCep('11000000')?.localidade_tipo).toBe('distrito');
    } finally {
      reader.close();
    }
  });

  test('loads a fixture into the default unified SQLite table', () => {
    const dneDir = join(workDir, 'dne');
    const dbPath = join(workDir, 'dne.db');

    createFixture(dneDir, 40);
    writeFileSync(join(workDir, '.dne.db.fetch.lock'), '');
    fetchDatabase(dbPath, dneDir);

    expect(readdirSync(workDir).filter((name) => name.startsWith('.dne.db.'))).toEqual([]);
    expect(existsSync(temporaryFetchLockPath(dbPath))).toBe(false);

    const db = new Database(dbPath, { readonly: true });
    try {
      const tables = db
        .query('SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\' ORDER BY name')
        .all() as { name: string; }[];
      expect(tables.map((row) => row.name)).toEqual([SQLITE_CEP_TABLE_NAME, 'bairros', 'bairro_faixas', 'edne_metadata'].sort());

      const cep = db.query(`SELECT * FROM ${SQLITE_CEP_TABLE_NAME}_consulta WHERE cep = ?`).get('30000001');
      expect(cep).toEqual({
        cep: '30000001',
        logradouro: 'Rua Endereco 1',
        complemento: null,
        bairro: 'Bairro 1',
        municipio: 'Municipio 1',
        municipio_cod_ibge: 2900001,
        uf: 'BA',
        nome: null,
        localidade_situacao: 1,
        localidade_tipo: 'M',
      });

      const sourceKind = db.query('SELECT value FROM edne_metadata WHERE key = ?').get('source_kind');
      expect(sourceKind).toEqual({ value: 'local' });

      const qualityRow = db.query('SELECT value FROM edne_metadata WHERE key = ?').get('quality_report') as {
        value: string;
      };
      const quality = JSON.parse(qualityRow.value) as LoadQualityReport;
      expect(quality).toMatchObject({
        version: 1,
        status: 'passed',
        output_rows: 47,
        totals: { read: 128, accepted: 128, rejected: 0 },
      });
      expect(quality.stages['log_localidade']?.files['LOG_LOCALIDADE.TXT']).toEqual({
        read: 40,
        accepted: 40,
        rejected: 0,
        rejection_reasons: {},
      });
      expect(quality.stages['log_logradouro']?.files).toMatchObject({
        'LOG_LOGRADOURO_BA.TXT': { read: 20, accepted: 20, rejected: 0 },
        'LOG_LOGRADOURO_SP.TXT': { read: 20, accepted: 20, rejected: 0 },
      });
    } finally {
      db.close();
    }
  });

  test('preserves the source locality indicators for every category of CEP', () => {
    const dneDir = join(workDir, 'localities');
    const dbPath = join(workDir, 'localities.db');
    createLocalityFixture(dneDir);
    fetchDatabase(dbPath, dneDir);

    const db = new Database(dbPath);
    try {
      const rows = db.query(`
        SELECT cep, localidade_situacao, localidade_tipo, municipio_cod_ibge
        FROM dne ORDER BY cep
      `).values();
      expect(rows).toEqual([
        ['10000000', 0, 'M', 3500002],
        ['11000000', 0, 'D', 3500006],
        ['12000000', 3, 'M', 3500006],
        ['13000000', 3, 'D', 3500006],
        ['14000000', 3, 'P', 3500006],
        ['21000000', 1, 'M', 3500001],
        ['24000000', 2, 'P', 3500001],
        ['25000000', 1, 'D', 3500001],
        ['26000000', 3, 'M', 3500006],
        ['27000000', 3, 'D', 3500006],
        ['28000000', 3, 'P', 3500006],
        ['41000000', 1, 'M', 3500001],
        ['42000000', 0, 'M', 3500002],
        ['44000000', 2, 'P', 3500001],
        ['46000000', 3, 'M', 3500006],
        ['52000000', 0, 'M', 3500002],
        ['57000000', 3, 'D', 3500006],
        ['62000000', 0, 'M', 3500002],
        ['64000000', 2, 'P', 3500001],
        ['68000000', 3, 'P', 3500006],
      ]);
      expect(
        db.query(`
        SELECT DISTINCT municipio FROM dne
        WHERE localidade_situacao = 0 AND localidade_tipo = 'M'
      `).values(),
      ).toEqual([['Municipio Unico']]);
      for (const value of [null, -1, 4, 1.5]) {
        expect(() => db.run('UPDATE dne SET localidade_situacao = ?', [value])).toThrow();
      }
      for (const value of [null, '', 'X']) {
        expect(() => db.run('UPDATE dne SET localidade_tipo = ?', [value])).toThrow();
      }
    } finally {
      db.close();
    }
  });

  test.each([
    [4, '', 'missing_situacao'],
    [4, '4', 'invalid_localidade_situacao'],
    [4, '-1', 'invalid_localidade_situacao'],
    [4, '03', 'invalid_localidade_situacao'],
    [4, '1.0', 'invalid_localidade_situacao'],
    [5, '', 'missing_tipo'],
    [5, 'X', 'invalid_localidade_tipo'],
  ])('rejects invalid locality field %i = %s', async (fieldIndex, value, reason) => {
    const dneDir = join(workDir, `invalid-locality-${fieldIndex}-${value}`);
    const dbPath = `${dneDir}.db`;
    createLocalityFixture(dneDir);
    const writer = new DneDatabaseWriter(dbPath, buildSchema({ cep_unificado: SQLITE_CEP_TABLE_NAME }));
    const source = new DirectoryDneSource(join(dneDir, 'Delimitado'));
    try {
      await writer.loadFromSource(source);
      replaceDelimitedField(join(dneDir, 'Delimitado', 'LOG_LOCALIDADE.TXT'), 0, fieldIndex, value);
      const error = await writer.loadFromSource(source).catch((error: unknown) => error);
      expect(String(error)).toContain(reason);
    } finally {
      writer.close();
    }
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(db.query('SELECT localidade_situacao, localidade_tipo FROM dne WHERE cep = ?').values('21000000'))
        .toEqual([[1, 'M']]);
      expect(db.query('SELECT count(*) FROM dne').values()).toEqual([[20]]);
    } finally {
      db.close();
    }
  });

  test.each(
    [
      ['LOG_LOCALIDADE.TXT', 0, 1, 'XX', 'invalid_uf'],
      ['LOG_LOCALIDADE.TXT', 0, 3, '123', 'invalid_cep'],
      ['LOG_LOCALIDADE.TXT', 1, 0, '1', 'duplicate_localidade'],
      ['LOG_LOCALIDADE.TXT', 2, 1, 'RJ', 'localidade_uf_mismatch'],
      ['LOG_LOCALIDADE.TXT', 0, 8, '', 'missing_ibge'],
      ['LOG_BAIRRO.TXT', 0, 3, '', 'missing_bairro'],
      ['LOG_BAIRRO.TXT', 0, 0, '-1', 'invalid_bairro_identifier'],
      ['LOG_BAIRRO.TXT', 0, 2, '-1', 'invalid_bairro_identifier'],
      ['LOG_BAIRRO.TXT', 0, 1, 'XX', 'invalid_uf'],
      ['LOG_BAIRRO.TXT', 0, 1, 'RJ', 'bairro_uf_mismatch'],
      ['LOG_BAIRRO.TXT', 1, 0, '11', 'duplicate_bairro'],
      ['LOG_LOGRADOURO_SP.TXT', 0, 5, '', 'missing_logNo'],
      ['LOG_LOGRADOURO_SP.TXT', 0, 1, 'XX', 'invalid_uf'],
      ['LOG_LOGRADOURO_SP.TXT', 0, 8, '', 'missing_tloTx'],
      ['LOG_LOGRADOURO_SP.TXT', 0, 3, '999', 'missing_bairro'],
      ['LOG_LOGRADOURO_SP.TXT', 0, 1, 'RJ', 'logradouro_uf_mismatch'],
      ['LOG_LOGRADOURO_SP.TXT', 0, 3, '12', 'bairro_localidade_mismatch'],
      ['LOG_CPC.TXT', 0, 3, '', 'missing_nome'],
      ['LOG_CPC.TXT', 0, 5, '123', 'invalid_cep'],
      ['LOG_CPC.TXT', 0, 1, 'RJ', 'cpc_uf_mismatch'],
      ['LOG_GRANDE_USUARIO.TXT', 0, 5, '', 'missing_nome'],
      ['LOG_GRANDE_USUARIO.TXT', 0, 1, 'XX', 'invalid_uf'],
      ['LOG_GRANDE_USUARIO.TXT', 0, 7, '123', 'invalid_cep'],
      ['LOG_GRANDE_USUARIO.TXT', 0, 3, '999', 'missing_bairro'],
      ['LOG_GRANDE_USUARIO.TXT', 0, 1, 'RJ', 'address_uf_mismatch'],
      ['LOG_GRANDE_USUARIO.TXT', 0, 3, '11', 'bairro_localidade_mismatch'],
      ['LOG_UNID_OPER.TXT', 0, 7, '123', 'invalid_cep'],
    ] as const,
  )('rejects %s row %i field %i = %s with %s and rolls back', async (file, row, field, value, reason) => {
    const directory = mkdtempSync(join(workDir, 'invalid-field-'));
    createLocalityFixture(directory);
    const path = join(directory, 'dne.db');
    const source = new DirectoryDneSource(join(directory, 'Delimitado'));
    const writer = new DneDatabaseWriter(path, buildSchema({ cep_unificado: SQLITE_CEP_TABLE_NAME }));
    try {
      expect(await writer.loadFromSource(source, { source_kind: 'valid' })).toBe(20);
      replaceDelimitedField(join(directory, 'Delimitado', file), row, field, value);
      expect(await captureRejection(writer.loadFromSource(source, { source_kind: 'invalid' })))
        .toMatchObject({ message: expect.stringContaining(reason) });
    } finally {
      writer.close();
    }
    using reader = new DneDatabaseReader(path);
    expect(reader.rowCount(SQLITE_CEP_TABLE_NAME)).toBe(20);
    expect(reader.metadata()?.['source_kind']).toBe('valid');
  });

  test('rejects addresses whose parent municipality was rejected', async () => {
    const directory = join(workDir, 'rejected-parent');
    createLocalityFixture(directory);
    const locality = join(directory, 'Delimitado', 'LOG_LOCALIDADE.TXT');
    appendFileSync(locality, '\n9@SP@Rejected Parent@@1@M@999@@3500009', 'latin1');
    for (const row of [3, 6, 7]) {
      replaceDelimitedField(locality, row, 6, '9');
    }
    const writer = new DneDatabaseWriter(':memory:', buildSchema({ cep_unificado: SQLITE_CEP_TABLE_NAME }));
    try {
      expect(await captureRejection(writer.loadFromSource(new DirectoryDneSource(join(directory, 'Delimitado')))))
        .toMatchObject({ message: expect.stringContaining('missing_municipality') });
    } finally {
      writer.close();
    }
  });

  test('rejects a source that has municipalities but produces no CEPs', async () => {
    const directory = join(workDir, 'no-ceps');
    createLocalityFixture(directory);
    const delimited = join(directory, 'Delimitado');
    for (const file of readdirSync(delimited)) {
      writeFileSync(join(delimited, file), file === 'LOG_LOCALIDADE.TXT' ? '1@SP@Municipio@@1@M@@@3500001' : '');
    }
    const writer = new DneDatabaseWriter(':memory:', buildSchema({ cep_unificado: SQLITE_CEP_TABLE_NAME }));
    try {
      expect(await captureRejection(writer.loadFromSource(new DirectoryDneSource(delimited))))
        .toMatchObject({ message: expect.stringContaining('no CEP rows produced') });
    } finally {
      writer.close();
    }
  });

  test('reports a missing source table definition', async () => {
    const schema = buildSchema({ cep_unificado: SQLITE_CEP_TABLE_NAME }).filter((table) => table.originalName !== 'log_localidade');
    const writer = new DneDatabaseWriter(':memory:', schema);
    try {
      expect(await captureRejection(writer.loadFromSource(new DirectoryDneSource(workDir))))
        .toMatchObject({ message: 'Table with original name \'log_localidade\' not found' });
    } finally {
      writer.close();
    }
  });

  test('rebuilds an existing eight-column database from the source', () => {
    const dneDir = join(workDir, 'legacy');
    const dbPath = join(workDir, 'legacy.db');
    createLocalityFixture(dneDir);
    const db = new Database(dbPath);
    db.run(`CREATE TABLE dne (
      cep TEXT PRIMARY KEY, logradouro TEXT, complemento TEXT, bairro TEXT,
      municipio TEXT NOT NULL, municipio_cod_ibge INTEGER NOT NULL, uf TEXT NOT NULL, nome TEXT
    ) WITHOUT ROWID`);
    db.run('INSERT INTO dne VALUES (\'99999999\', NULL, NULL, NULL, \'Antigo\', 3500000, \'SP\', NULL)');
    try {
      const reader = new DneDatabaseReader(dbPath);
      try {
        expect(() => reader.queryCep('99999999')).toThrow('build --force');
      } finally {
        reader.close();
      }
      fetchDatabase(dbPath, dneDir);
      expect(db.query('SELECT count(*) FROM dne WHERE cep = ?').values('99999999')).toEqual([[0]]);
      expect(db.query('SELECT localidade_situacao, localidade_tipo FROM dne WHERE cep = ?').values('10000000'))
        .toEqual([[0, 'M']]);
    } finally {
      db.close();
    }
  });

  test('rebuilds the former locality CHECK constraint when updating SQLite', () => {
    const dneDir = join(workDir, 'legacy-locality-check');
    const dbPath = `${dneDir}.db`;
    createLocalityFixture(dneDir);
    const table = getUnifiedTable(buildSchema({ cep_unificado: SQLITE_CEP_TABLE_NAME }));
    const situationColumn = table.columns.find((column) => column.name === 'localidade_situacao');
    if (!situationColumn) {
      throw new Error('Missing locality situation column');
    }
    situationColumn.check = 'localidade_situacao IN (0, 1, 2)';
    const db = new Database(dbPath);
    try {
      db.run(createTableSql(table));
      fetchDatabase(dbPath, dneDir);
      expect(db.query('SELECT localidade_situacao FROM dne WHERE cep = ?').values('12000000')).toEqual([[3]]);
      expect(db.query('SELECT count(*) FROM dne').values()).toEqual([[20]]);
      expect(() => db.run('UPDATE dne SET localidade_situacao = 4')).toThrow();
    } finally {
      db.close();
    }
  });

  test('loads batches within SQLite parameter limits', () => {
    const dneDir = join(workDir, 'large-dne');
    const dbPath = join(workDir, 'large-dne.db');

    createFixture(dneDir, 2500);
    fetchDatabase(dbPath, dneDir);

    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.query(`SELECT count(*) AS count FROM ${SQLITE_CEP_TABLE_NAME}`).get() as { count: number; };
      expect(row.count).toBeGreaterThan(2500);
    } finally {
      db.close();
    }
  });

  test('streams files from a nested ZIP into SQLite', () => {
    const fixtureDirectory = join(workDir, 'nested-zip-fixture');
    const zipPath = createNestedZipFixture(fixtureDirectory, 250);
    const directoryDbPath = join(workDir, 'nested-directory.db');
    const zipDbPath = join(workDir, 'nested-zip.db');

    fetchDatabase(directoryDbPath, join(fixtureDirectory, 'dne'));
    fetchDatabase(zipDbPath, zipPath);

    const directoryDb = new Database(directoryDbPath, { readonly: true });
    const zipDb = new Database(zipDbPath, { readonly: true });
    try {
      const rows = `SELECT * FROM ${SQLITE_CEP_TABLE_NAME} ORDER BY cep`;
      expect(zipDb.query(rows).all()).toEqual(directoryDb.query(rows).all());
    } finally {
      directoryDb.close();
      zipDb.close();
    }
  });

  test('rejects malformed rows and preserves the last valid load', async () => {
    const validDneDir = join(workDir, 'quality-valid-dne');
    const invalidDneDir = join(workDir, 'quality-invalid-dne');
    const dbPath = join(workDir, 'quality-preserved.db');
    createFixture(validDneDir, 40);
    createFixture(invalidDneDir, 40);

    replaceDelimitedField(join(invalidDneDir, 'Delimitado', 'LOG_LOCALIDADE.TXT'), 0, 8, '123');
    replaceDelimitedField(join(invalidDneDir, 'Delimitado', 'LOG_CPC.TXT'), 0, 1, 'XX');
    replaceDelimitedField(join(invalidDneDir, 'Delimitado', 'LOG_LOGRADOURO_BA.TXT'), 0, 7, '1234567');

    const schema = buildSchema({ cep_unificado: SQLITE_CEP_TABLE_NAME });
    const writer = new DneDatabaseWriter(dbPath, schema);
    const validCount = await writer.loadFromSource(
      new DirectoryDneSource(join(validDneDir, 'Delimitado')),
      { source_kind: 'valid' },
    );

    let loadError: unknown;
    try {
      await writer.loadFromSource(
        new DirectoryDneSource(join(invalidDneDir, 'Delimitado')),
        { source_kind: 'invalid' },
      );
    } catch (error) {
      loadError = error;
    } finally {
      writer.close();
    }

    expect(String(loadError)).toContain('DNE source quality validation failed');
    expect(String(loadError)).toContain('invalid_cep=1');
    expect(String(loadError)).toContain('invalid_uf=1');
    expect(String(loadError)).toContain('invalid_ibge=1');

    const db = new Database(dbPath, { readonly: true });
    try {
      expect(
        (db.query(`SELECT count(*) AS count FROM ${SQLITE_CEP_TABLE_NAME}`).get() as { count: number; }).count,
      ).toBe(validCount);
      expect(db.query('SELECT value FROM edne_metadata WHERE key = ?').get('source_kind')).toEqual({ value: 'valid' });
      expect(db.query(`SELECT cep FROM ${SQLITE_CEP_TABLE_NAME} WHERE cep = ?`).get('30000001')).toEqual({
        cep: '30000001',
      });
    } finally {
      db.close();
    }
  });
});

function temporaryFetchLockPath(target: string) {
  const targetHash = new Bun.CryptoHasher('sha256').update(target).digest('hex');
  return join(tmpdir(), `konstit-dne-${process.getuid?.() ?? 'unknown'}`, `fetch-${targetHash}.lock`);
}

function replaceDelimitedField(path: string, lineIndex: number, fieldIndex: number, value: string) {
  const lines = readFileSync(path, 'latin1').split('\n');
  const line = lines[lineIndex];
  if (!line) {
    throw new Error(`Missing fixture line ${lineIndex} in ${path}`);
  }
  const fields = line.split('@');
  if (fields[fieldIndex] === undefined) {
    throw new Error(`Missing fixture field ${fieldIndex} in ${path}`);
  }
  fields[fieldIndex] = value;
  lines[lineIndex] = fields.join('@');
  writeFileSync(path, lines.join('\n'), 'latin1');
}
