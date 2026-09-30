import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  buildSchema,
  getSourceFieldIndexes,
  getTableFilesGlob,
  getUnifiedTable,
} from '../src/schema.ts';
import {
  expectRejects,
  run,
} from './helpers.ts';

describe('schema', () => {
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
  test('run reports a failed subprocess', () => {
    expect(() => run('bun', ['-e', 'process.exit(7)'])).toThrow('bun -e process.exit(7) failed');
  });

  test('expectRejects reports a fulfilled promise', async () => {
    const rejection = expectRejects(Promise.resolve()).catch((error: unknown) => error);
    expect(await rejection).toEqual(new Error('Expected promise to reject'));
  });
});
