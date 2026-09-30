import { Database } from 'bun:sqlite';
import {
  afterAll,
  afterEach,
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

  test('wraps a close failure and permits retrying the close', () => {
    const reader = new DneDatabaseReader(emptyPath);
    const cause = new Error('Close failed');
    const close = spyOn(Database.prototype, 'close').mockImplementationOnce(() => {
      throw cause;
    });
    try {
      const error = captureError(() => reader.close());
      expect(error).toMatchObject({ code: 'IO_ERROR', path: emptyPath });
      expect(error.cause).toBe(cause);
      expect(reader.hasTable('dne')).toBe(false);
    } finally {
      close.mockRestore();
      reader.close();
    }
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

  test('identifies a lookup view that lacks locality columns', () => {
    const path = createDatabase('CREATE VIEW dne_consulta AS SELECT \'01001000\' AS cep');
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
      `CREATE VIEW dne_consulta AS SELECT '01001000' AS cep, ${situation ?? 'NULL'} AS localidade_situacao, '${type}' AS localidade_tipo`,
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
