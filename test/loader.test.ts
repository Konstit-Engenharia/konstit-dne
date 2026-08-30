import { Database } from 'bun:sqlite';
import {
  afterAll,
  describe,
  expect,
  test,
} from 'bun:test';
import {
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
  DneDatabaseWriter,
  type LoadQualityReport,
} from '../src/db.ts';
import { DirectoryDneSource } from '../src/dne-source.ts';
import { buildSchema } from '../src/schema.ts';
import { SQLITE_CEP_TABLE_NAME } from '../src/settings.ts';
import {
  createFixture,
  createNestedZipFixture,
  fetchDatabase,
} from './helpers.ts';

const workDir = mkdtempSync(join(tmpdir(), 'edne-loader-test-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('loader', () => {
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
      expect(tables.map((row) => row.name)).toEqual([SQLITE_CEP_TABLE_NAME, 'edne_metadata'].sort());

      const cep = db.query(`SELECT * FROM ${SQLITE_CEP_TABLE_NAME} WHERE cep = ?`).get('30000001');
      expect(cep).toEqual({
        cep: '30000001',
        logradouro: 'Rua Endereco 1',
        complemento: null,
        bairro: 'Bairro 1',
        municipio: 'Municipio 1',
        municipio_cod_ibge: 3500001,
        uf: 'BA',
        nome: null,
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
        totals: { read: 127, accepted: 127, rejected: 0 },
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
