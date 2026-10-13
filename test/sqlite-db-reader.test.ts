import { Database, type Statement } from 'bun:sqlite';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as legacy from '../src/db.ts';
import { DirectoryDneSource } from '../src/dne-source.ts';
import { buildSchema } from '../src/schema.ts';
import {
  DneDatabaseClosedError,
  DneDatabaseDataError,
  DneDatabaseError,
  DneDatabaseIOError,
  DneDatabaseQueryError,
  DneDatabaseReader,
  DneDatabaseSchemaError,
  hasTable,
  readDatabaseMetadata,
} from '../src/sqlite-db-reader.ts';
import { DneDatabaseWriter } from '../src/sqlite-db-writer.ts';
import { captureRejection } from './assertions.ts';
import { createLocalityFixture } from './helpers.ts';

const directory = mkdtempSync(join(tmpdir(), 'dne-sqlite-reader-'));
const readOperations: [string, (reader: DneDatabaseReader) => unknown][] = [
  ['hasTable', (reader) => reader.hasTable('dne')],
  ['metadata', (reader) => reader.metadata()],
  ['queryCep', (reader) => reader.queryCep('01001000')],
  ['queryNeighborhood', (reader) => reader.queryNeighborhood(1)],
  ['queryNeighborhoodByCep', (reader) => reader.queryNeighborhoodByCep('01001000')],
  ['queryNeighborhoodCepRanges', (reader) => reader.queryNeighborhoodCepRanges(1)],
  ['rowCount', (reader) => reader.rowCount('dne')],
  ['tableSchema', (reader) => reader.tableSchema('dne')],
  ['querySql', (reader) => reader.querySql('SELECT 1', 1)],
];

afterEach(() => mock.restore());
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function createDatabase(sql: string) {
  const path = join(directory, `${crypto.randomUUID()}.db`);
  const db = new Database(path);
  try {
    db.run(sql);
  } finally {
    db.close();
  }
  return path;
}

function captureError(read: () => unknown): Error {
  try {
    read();
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return error;
  }
  throw new Error('Expected operation to throw');
}

const emptyPath = createDatabase('PRAGMA user_version = 1');

describe('SQLite lookup statements', () => {
  const path = join(directory, 'lookups.db');
  const lookups: [string, (reader: DneDatabaseReader) => unknown][] = [
    ['queryCep', (reader) => reader.queryCep('21000000')],
    ['queryNeighborhood', (reader) => reader.queryNeighborhood(11)],
    ['queryNeighborhoodByCep', (reader) => reader.queryNeighborhoodByCep('21000000')],
    ['queryNeighborhoodCepRanges', (reader) => reader.queryNeighborhoodCepRanges(11)],
  ];

  beforeAll(async () => {
    const source = join(directory, 'source');
    createLocalityFixture(source);
    const writer = new DneDatabaseWriter(path, buildSchema({ cep_unificado: 'dne' }));
    try {
      await writer.loadFromSource(new DirectoryDneSource(join(source, 'Delimitado')));
    } finally {
      writer.close();
    }
  });

  test('prepares lookups only when needed and reuses them across parameters and arbitrary SQL', () => {
    const prepare = spyOn(Database.prototype, 'prepare');
    using reader = new DneDatabaseReader(path);
    expect(prepare).not.toHaveBeenCalled();
    expect(reader.queryCep('invalid')).toBeUndefined();
    expect(reader.queryNeighborhood(-1)).toBeUndefined();
    expect(reader.queryNeighborhoodByCep('invalid')).toBeUndefined();
    expect(reader.queryNeighborhoodCepRanges(-1)).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();

    const expected = lookups.map(([, read]) => read(reader));
    expect(prepare).toHaveBeenCalledTimes(4);
    const sql = prepare.mock.calls.map(([query]) => query);
    for (const query of sql) {
      reader.querySql(query, 1);
    }
    for (let i = 0; i < 32; i++) {
      reader.querySql(`SELECT ${i} AS value`, 1);
    }
    expect(lookups.map(([, read]) => read(reader))).toEqual(expected);
    expect(reader.queryCep('24000-000')?.cep).toBe('24000000');
    expect(reader.queryNeighborhood(14)?.nome).toBe('Povoado');
    expect(reader.queryNeighborhoodByCep('24000000')?.bairro_id).toBe(14);
    expect(reader.queryNeighborhoodCepRanges(14)).toEqual([{ cep_inicial: '24000000', cep_final: '24000099' }]);
    expect(prepare).toHaveBeenCalledTimes(4);
  });

  test.each(lookups)('preserves a %s preparation failure and retries on the next lookup', (_name, read) => {
    using reader = new DneDatabaseReader(path);
    const cause = new Error('Unable to prepare lookup');
    const prepare = spyOn(Database.prototype, 'prepare').mockImplementationOnce(() => {
      throw cause;
    });
    const error = captureError(() => read(reader));
    expect(error).toBeInstanceOf(DneDatabaseQueryError);
    expect(error.cause).toBe(cause);
    expect(() => read(reader)).not.toThrow();
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  test.each(['close', 'dispose'])('finalizes all retained statements on %s', (method) => {
    const prepare = spyOn(Database.prototype, 'prepare');
    const reader = new DneDatabaseReader(path);
    try {
      for (const [, read] of lookups) {
        read(reader);
      }
      expect(prepare).toHaveBeenCalledTimes(4);
      const statements = prepare.mock.results.map((result) => result.value as Statement);
      if (method === 'close') {
        reader.close();
      } else {
        reader[Symbol.dispose]();
      }
      for (const statement of statements) {
        expect(() => statement.all()).toThrow('Database has closed');
      }
      for (const [, read] of lookups) {
        expect(() => read(reader)).toThrow(DneDatabaseClosedError);
      }
    } finally {
      reader.close();
    }
  });

  test('keeps retained lookups usable if closing the connection fails before cleanup', () => {
    using reader = new DneDatabaseReader(path);
    const expected = lookups.map(([, read]) => read(reader));
    const cause = new Error('Unable to close connection');
    const close = spyOn(Database.prototype, 'close').mockImplementationOnce(() => {
      throw cause;
    });
    const error = captureError(() => reader.close());
    expect(error).toBeInstanceOf(DneDatabaseIOError);
    expect(error.cause).toBe(cause);
    expect(lookups.map(([, read]) => read(reader))).toEqual(expected);
    close.mockRestore();
    reader.close();
  });
});

describe('SQLite reader errors', () => {
  test('keeps the existing db module exports compatible', () => {
    expect(legacy.DneDatabaseReader).toBe(DneDatabaseReader);
    expect(legacy.DneDatabaseWriter).toBe(DneDatabaseWriter);
    expect(legacy.DneDatabaseError).toBe(DneDatabaseError);
    expect(legacy.DneDatabaseIOError).toBe(DneDatabaseIOError);
    expect(legacy.DneDatabaseSchemaError).toBe(DneDatabaseSchemaError);
    expect(legacy.DneDatabaseDataError).toBe(DneDatabaseDataError);
    expect(legacy.DneDatabaseQueryError).toBe(DneDatabaseQueryError);
    expect(legacy.DneDatabaseClosedError).toBe(DneDatabaseClosedError);
    expect(legacy.hasTable).toBe(hasTable);
    expect(legacy.readDatabaseMetadata).toBe(readDatabaseMetadata);
  });

  test('wraps an opening failure with the path and original cause without creating a file', () => {
    const path = join(directory, 'missing.db');
    const error = captureError(() => new DneDatabaseReader(path));
    expect(error).toBeInstanceOf(DneDatabaseError);
    expect(error).toBeInstanceOf(DneDatabaseIOError);
    expect(error).toMatchObject({ name: 'DneDatabaseIOError', code: 'IO_ERROR', path, cause: expect.any(Error) });
    expect(existsSync(path)).toBe(false);
  });

  test('closes the connection if configuring the busy timeout fails', () => {
    const cause = new Error('Unable to configure connection');
    const run = spyOn(Database.prototype, 'run').mockImplementation(() => {
      throw cause;
    });
    const close = spyOn(Database.prototype, 'close');
    try {
      const error = captureError(() => new DneDatabaseReader(emptyPath));
      expect(error).toBeInstanceOf(DneDatabaseIOError);
      expect(error).toMatchObject({ path: emptyPath });
      expect(error.cause).toBe(cause);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      run.mockRestore();
      close.mockRestore();
    }
  });

  test('preserves the opening failure if closing the failed connection also throws', () => {
    const cause = new Error('Unable to configure connection');
    const run = spyOn(Database.prototype, 'run').mockImplementation(() => {
      throw cause;
    });
    const originalClose = Object.getOwnPropertyDescriptor(Database.prototype, 'close')?.value as Database['close'];
    const close = spyOn(Database.prototype, 'close').mockImplementation(function(this: Database) {
      originalClose.call(this);
      throw new Error('Cleanup failed');
    });
    try {
      const error = captureError(() => new DneDatabaseReader(emptyPath));
      expect(error).toMatchObject({ code: 'IO_ERROR' });
      expect(error.cause).toBe(cause);
    } finally {
      run.mockRestore();
      close.mockRestore();
    }
  });

  test.each(['close', 'dispose'])('wraps a %s failure and permits retrying cleanup', (method) => {
    const reader = new DneDatabaseReader(emptyPath);
    const cleanup = () => method === 'close' ? reader.close() : reader[Symbol.dispose]();
    const cause = new Error('Close failed');
    const close = spyOn(Database.prototype, 'close').mockImplementationOnce(() => {
      throw cause;
    });
    try {
      const error = captureError(cleanup);
      expect(error).toMatchObject({ code: 'IO_ERROR', path: emptyPath });
      expect(error.cause).toBe(cause);
      expect(reader.hasTable('dne')).toBe(false);
    } finally {
      close.mockRestore();
      reader.close();
    }
    expect(cleanup).not.toThrow();
  });

  test.each([false, true])('disposes a reader when leaving a using scope, throwing=%s', (throwing) => {
    const reader = new DneDatabaseReader(emptyPath);
    const failure = new Error('Scope failed');
    const read = () => {
      using scoped = reader;
      expect(scoped.querySql('SELECT 42 AS value', 1).rows).toEqual([{ value: 42 }]);
      if (throwing) {
        throw failure;
      }
    };
    if (throwing) {
      expect(read).toThrow(failure);
    } else {
      read();
    }
    expect(() => reader.hasTable('dne')).toThrow(DneDatabaseClosedError);
    expect(() => reader[Symbol.dispose]()).not.toThrow();
    expect(() => reader.close()).not.toThrow();
  });

  test.each(readOperations)('returns a typed closed error from %s', (_name, read) => {
    const reader = new DneDatabaseReader(emptyPath);
    reader.close();
    const error = captureError(() => read(reader));
    expect(error).toBeInstanceOf(DneDatabaseClosedError);
    expect(error).toMatchObject({ name: 'DneDatabaseClosedError', code: 'READER_CLOSED' });
    expect(() => reader.close()).not.toThrow();
  });

  test('rejects reads after close even when their input is invalid', () => {
    const reader = new DneDatabaseReader(emptyPath);
    expect(reader.metadata()).toBeUndefined();
    expect(reader.tableSchema('missing')).toBeUndefined();
    expect(reader.queryCep('invalid')).toBeUndefined();
    expect(reader.queryNeighborhood(-1)).toBeUndefined();
    expect(reader.queryNeighborhoodByCep('invalid')).toBeUndefined();
    expect(reader.queryNeighborhoodCepRanges(-1)).toEqual([]);
    reader.close();
    expect(() => reader.queryCep('invalid')).toThrow(DneDatabaseClosedError);
    expect(() => reader.queryNeighborhood(-1)).toThrow(DneDatabaseClosedError);
    expect(() => reader.queryNeighborhoodByCep('invalid')).toThrow(DneDatabaseClosedError);
    expect(() => reader.queryNeighborhoodCepRanges(-1)).toThrow(DneDatabaseClosedError);
    expect(() => reader.querySql('SELECT 1', Number.NaN)).toThrow(DneDatabaseClosedError);
  });

  test.each(readOperations)('preserves native failures from %s in a typed query error', (_name, read) => {
    const reader = new DneDatabaseReader(emptyPath);
    const cause = new Error('SQLite read failed');
    const query = spyOn(Database.prototype, 'query').mockImplementation(() => {
      throw cause;
    });
    try {
      const error = captureError(() => read(reader));
      expect(error).toBeInstanceOf(DneDatabaseError);
      expect(error).toBeInstanceOf(DneDatabaseQueryError);
      expect(error).toMatchObject({ name: 'DneDatabaseQueryError', code: 'QUERY_ERROR', message: cause.message });
      expect(error.cause).toBe(cause);
    } finally {
      query.mockRestore();
      reader.close();
    }
  });

  test('preserves rejection values that are not Error instances', () => {
    const reader = new DneDatabaseReader(emptyPath);
    const query = spyOn(Database.prototype, 'query').mockImplementation(() => {
      throw 'SQLite failure';
    });
    try {
      expect(captureError(() => reader.rowCount('dne'))).toMatchObject({
        code: 'QUERY_ERROR',
        cause: 'SQLite failure',
        message: 'SQLite failure',
      });
    } finally {
      query.mockRestore();
      reader.close();
    }
  });

  test('wraps SQL preparation and execution failures while keeping the connection usable', () => {
    const path = createDatabase('CREATE TABLE example (id INTEGER); INSERT INTO example VALUES (1)');
    const reader = new DneDatabaseReader(path);
    try {
      const preparation = captureError(() => reader.querySql('SELECT * FROM missing', 10));
      expect(preparation).toBeInstanceOf(DneDatabaseQueryError);
      expect(preparation).toMatchObject({ cause: expect.any(Error), message: expect.stringContaining('missing') });
      const execution = captureError(() => reader.querySql('DELETE FROM example RETURNING id', 10));
      expect(execution).toBeInstanceOf(DneDatabaseQueryError);
      expect(execution).toMatchObject({ cause: expect.any(Error), message: expect.stringContaining('readonly') });
      expect(reader.querySql('SELECT * FROM example', 10)).toEqual({ rows: [{ id: 1 }], truncated: false });
    } finally {
      reader.close();
    }
  });

  test('reports missing normalized schema separately from native query failures', () => {
    const reader = new DneDatabaseReader(emptyPath);
    try {
      const error = captureError(() => reader.queryCep('01001000'));
      expect(error).toBeInstanceOf(DneDatabaseSchemaError);
      expect(error).toMatchObject({ code: 'INVALID_SCHEMA', message: expect.stringContaining('normalized neighborhoods') });
    } finally {
      reader.close();
    }
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid SQL row limit %s before preparing the statement',
    (limit) => {
      using reader = new DneDatabaseReader(emptyPath);
      const error = captureError(() => reader.querySql('SELECT * FROM missing', limit));
      expect(error).toBeInstanceOf(DneDatabaseQueryError);
      expect(error).toMatchObject({ code: 'QUERY_ERROR', message: 'SQL row limit must be a positive safe integer.' });
      expect(reader.querySql('SELECT 1 AS value', 1)).toEqual({ rows: [{ value: 1 }], truncated: false });
    },
  );

  test('bounds SQL results and distinguishes an exact limit from truncation', () => {
    using reader = new DneDatabaseReader(emptyPath);
    const sql = 'SELECT 1 AS value UNION ALL SELECT 2 UNION ALL SELECT 3';
    expect(reader.querySql(sql, 2)).toEqual({ rows: [{ value: 1 }, { value: 2 }], truncated: true });
    expect(reader.querySql(sql, 3)).toEqual({ rows: [{ value: 1 }, { value: 2 }, { value: 3 }], truncated: false });
    expect(reader.querySql('SELECT 1 AS value WHERE 0', 1)).toEqual({ rows: [], truncated: false });
  });

  test.each(['bairros', 'bairro_faixas'])('reports an incomplete normalized schema containing only %s', (table) => {
    const path = createDatabase(`
      CREATE VIEW dne_consulta AS SELECT '01001000' AS cep;
      CREATE TABLE ${table} (bairro_id INTEGER);
    `);
    using reader = new DneDatabaseReader(path);
    expect(() => reader.queryCep('01001000')).toThrow(DneDatabaseSchemaError);
    expect(() => reader.queryNeighborhood(1)).toThrow(DneDatabaseSchemaError);
    expect(() => reader.queryNeighborhoodByCep('01001000')).toThrow(DneDatabaseSchemaError);
    expect(() => reader.queryNeighborhoodCepRanges(1)).toThrow(DneDatabaseSchemaError);
  });

  test('identifies a lookup view that lacks locality columns', () => {
    const path = createDatabase(`
      CREATE TABLE bairros (bairro_id INTEGER);
      CREATE TABLE bairro_faixas (bairro_id INTEGER);
      CREATE VIEW dne_consulta AS SELECT '01001000' AS cep;
    `);
    const reader = new DneDatabaseReader(path);
    try {
      const error = captureError(() => reader.queryCep('01001000'));
      expect(error).toBeInstanceOf(DneDatabaseSchemaError);
      expect(error).toMatchObject({ code: 'INVALID_SCHEMA', message: expect.stringContaining('locality indicators') });
    } finally {
      reader.close();
    }
  });

  test.each([[4, 'M'], [1, 'Z'], [null, 'M']])('identifies invalid locality data (%s, %s)', (situation, type) => {
    const path = createDatabase(
      `CREATE TABLE bairros (bairro_id INTEGER);
       CREATE TABLE bairro_faixas (bairro_id INTEGER);
       CREATE VIEW dne_consulta AS SELECT '01001000' AS cep, ${situation ?? 'NULL'} AS localidade_situacao, '${type}' AS localidade_tipo`,
    );
    const reader = new DneDatabaseReader(path);
    try {
      const error = captureError(() => reader.queryCep('01001000'));
      expect(error).toBeInstanceOf(DneDatabaseDataError);
      expect(error).toMatchObject({ name: 'DneDatabaseDataError', code: 'INVALID_DATA' });
    } finally {
      reader.close();
    }
  });

  test('uses typed query errors in the file helpers and closes their connections on failure', async () => {
    const path = join(directory, 'corrupt.db');
    writeFileSync(path, 'not a SQLite database');
    const close = spyOn(Database.prototype, 'close');
    try {
      expect(await captureRejection(readDatabaseMetadata(path))).toBeInstanceOf(DneDatabaseQueryError);
      expect(await captureRejection(hasTable(path, 'dne'))).toBeInstanceOf(DneDatabaseQueryError);
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      close.mockRestore();
    }
  });
});
