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
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLITE_CEP_TABLE_NAME } from '../src/settings.ts';
import {
  createFixture,
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
    fetchDatabase(dbPath, dneDir);

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
});
