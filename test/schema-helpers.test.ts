import { Database } from 'bun:sqlite';
import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  prepareTableForLoad,
  selectDelimitedFields,
} from '../src/db.ts';
import type { TableDefinition } from '../src/schema.ts';
import {
  buildSchema,
  getSourceFieldIndexes,
  getTableFilesGlob,
  getUnifiedTable,
} from '../src/schema.ts';
import { captureRejection } from './assertions.ts';
import {
  expectRejects,
  run,
} from './helpers.ts';

describe('schema', () => {
  test('selects and trims delimited fields while preserving empty and missing values', () => {
    expect(selectDelimitedFields(' left @ignored@@ right ', [0, 2, 3, 5])).toEqual(['left', null, 'right', null]);
    expect(selectDelimitedFields('a@b', [])).toEqual([]);
  });

  test('retains compatible tables and replaces outdated columns and checks', () => {
    const db = new Database(':memory:');
    const table: TableDefinition = {
      name: 'example',
      originalName: 'example',
      columns: [{ name: 'id', type: 'INTEGER', primaryKey: true }],
    };
    try {
      prepareTableForLoad(db, table);
      db.run('INSERT INTO example VALUES (1)');
      prepareTableForLoad(db, table);
      expect(db.query('SELECT * FROM example').all()).toEqual([{ id: 1 }]);
      prepareTableForLoad(db, { ...table, columns: [{ name: 'id', type: 'INTEGER', check: 'id > 0' }] });
      expect(db.query('SELECT * FROM example').all()).toEqual([]);
      expect(() => db.run('INSERT INTO example VALUES (0)')).toThrow('CHECK');
      prepareTableForLoad(db, { ...table, columns: [{ name: 'value', type: 'TEXT' }] });
      db.run('INSERT INTO example VALUES (\'text\')');
      expect(db.query('SELECT value FROM example').all()).toEqual([{ value: 'text' }]);
      prepareTableForLoad(db, { ...table, columns: [...table.columns, { name: 'extra', type: 'TEXT' }] });
      expect(db.query('PRAGMA table_info(example)').all()).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test('rejects missing schema definitions and source mappings', () => {
    expect(() => getUnifiedTable([])).toThrow('Unified schema table not found');
    const table = { name: 'source', originalName: 'source', columns: [] };
    expect(() => getSourceFieldIndexes(table, ['cep'])).toThrow('Source fields for table \'source\' not found');
    expect(() => getSourceFieldIndexes({ ...table, sourceFields: {} }, ['cep']))
      .toThrow('Source field \'cep\' for table \'source\' not found');
  });

  test('builds an independent schema with optional table names', () => {
    const unifiedOriginalName = getUnifiedTable(buildSchema()).originalName;
    const schema = buildSchema({ [unifiedOriginalName]: 'custom_cep' });
    const cepTable = getUnifiedTable(schema);

    expect(cepTable.name).toBe('custom_cep');
    expect(schema.find((table) => table.originalName === 'log_bairro')?.name).toBe('log_bairro');

    const firstColumn = cepTable.columns[0];
    if (!firstColumn) {
      throw new Error('Missing unified CEP table columns');
    }
    firstColumn.name = 'changed';
    expect(getUnifiedTable(buildSchema()).columns[0]?.name).toBe('cep');
  });

  test('returns null for a unified table', () => {
    expect(getTableFilesGlob(getUnifiedTable(buildSchema()))).toBeNull();
  });

  test('returns an explicit file glob', () => {
    const table = buildSchema().find((candidate) => candidate.originalName === 'log_logradouro');
    expect(table && getTableFilesGlob(table)).toBe('LOG_LOGRADOURO_*.TXT');
  });

  test('derives the default file name from the original table name', () => {
    const table = buildSchema().find((candidate) => candidate.originalName === 'log_bairro');
    expect(table && getTableFilesGlob(table)).toBe('LOG_BAIRRO.TXT');
  });

  test('declares source field indexes used by the loader', () => {
    const table = buildSchema().find((candidate) => candidate.originalName === 'log_localidade');
    if (!table) {
      throw new Error('Missing localidade table');
    }
    expect(getSourceFieldIndexes(table, ['locNu', 'uf', 'cep', 'situacao', 'tipo', 'munNu'])).toEqual([0, 1, 3, 4, 5, 8]);
  });
});

describe('test helpers', () => {
  test('captureRejection preserves the rejection value and rejects a fulfilled promise', async () => {
    const error = new Error('failure');
    expect(await captureRejection(Promise.reject(error))).toBe(error);
    expect(await captureRejection(captureRejection(Promise.resolve()))).toEqual(new Error('Expected promise to reject'));
  });

  test('run reports a failed subprocess', () => {
    expect(() => run('bun', ['-e', 'process.exit(7)'])).toThrow('bun -e process.exit(7) failed');
  });

  test('expectRejects reports a fulfilled promise', async () => {
    const rejection = expectRejects(Promise.resolve()).catch((error: unknown) => error);
    expect(await rejection).toEqual(new Error('Expected promise to reject'));
  });
});
