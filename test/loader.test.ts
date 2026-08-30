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
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});

function temporaryFetchLockPath(target: string) {
  const targetHash = new Bun.CryptoHasher('sha256').update(target).digest('hex');
  return join(tmpdir(), `konstit-dne-${process.getuid?.() ?? 'unknown'}`, `fetch-${targetHash}.lock`);
}
