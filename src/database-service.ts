import { stat } from 'node:fs/promises';
import {
  extname,
  resolve,
} from 'node:path';
import {
  DneBinaryDatabaseReader,
  isBinaryDatabase,
  readBinaryDatabaseMetadata,
} from './binary-db-reader.ts';
import {
  DneDatabaseReader,
  hasTable as hasSqliteTable,
  readDatabaseMetadata as readSqliteDatabaseMetadata,
  sqlitePathFromDatabaseUrl,
  type LoadMetadata,
} from './db.ts';
import { UserError } from './errors.ts';
import { SQLITE_CEP_TABLE_NAME } from './settings.ts';

/**
 * Storage formats supported by the CLI and format-detecting database services.
 */
export type DatabaseFormat = 'binary' | 'sqlite';

/**
 * Inspection result for a local database, including diagnostics when opening or reading it fails.
 */
export type DatabaseInspection = {
  /**
   * Diagnostic message when the existing file cannot be inspected.
   */
  error?: string;
  /**
   * Whether the requested file exists; false for the in-memory sentinel.
   */
  exists: boolean;
  /**
   * Detected storage format, or null when unavailable.
   */
  format: DatabaseFormat | null;
  /**
   * Persisted import metadata, or null when unavailable.
   */
  metadata: LoadMetadata | null;
  /**
   * Database path supplied for inspection.
   */
  path: string;
  /**
   * Whether the file can be opened and contains the requested logical table; not a full row-validation result.
   */
  ready: boolean;
  /**
   * Number of rows in a ready database, or null when unavailable.
   */
  row_count: number | null;
  /**
   * Stored SQLite CREATE statement; null for binary databases and unavailable tables.
   */
  schema: string | null;
  /**
   * Main file size in bytes, excluding any SQLite WAL or journal files.
   */
  size_bytes: number | null;
};

/**
 * Resolves a database path or supported SQLite URL to an absolute filesystem path.
 * @param value - Plain path, SQLite URL, or `:memory:`.
 * @param format - When binary output is requested, replaces or appends the extension with `.bin`.
 * @returns An absolute path, preserving the in-memory sentinel.
 * @throws {Error} If the input uses an unsupported URL scheme.
 */
export function databasePath(value: string, format?: DatabaseFormat) {
  const path = sqlitePathFromDatabaseUrl(value);
  if (path === ':memory:') {
    return path;
  }
  return resolve(format === 'binary' ? `${path.slice(0, path.length - extname(path).length)}.bin` : path);
}

/**
 * Detects the storage format and opens a reader for the requested table.
 * The caller owns the returned reader and must close it.
 * @param path - Existing local database path.
 * @param tableName - Required table; binary files expose only the default logical CEP table.
 * @returns A SQLite or binary reader.
 * @throws {UserError} If the database is missing, cannot be opened, or lacks the requested table.
 */
export async function openReadyDatabase(path: string, tableName = SQLITE_CEP_TABLE_NAME) {
  if (path === ':memory:' || !(await Bun.file(path).exists())) {
    throw new UserError('database-not-found', `Base não encontrada: ${path}`);
  }

  let reader: DneDatabaseReader | DneBinaryDatabaseReader;
  try {
    reader = await isBinaryDatabase(path)
      ? new DneBinaryDatabaseReader(path)
      : new DneDatabaseReader(path);
  } catch (error) {
    throw new UserError('database-invalid', `Não foi possível abrir a base '${path}': ${errorMessage(error)}`);
  }

  const ready = reader instanceof DneBinaryDatabaseReader
    ? tableName === SQLITE_CEP_TABLE_NAME
    : reader.hasTable(tableName);
  if (!ready) {
    reader.close();
    throw new UserError(
      'database-not-ready',
      `A base '${path}' não contém a tabela '${tableName}'. Execute bunx @konstit/dne build primeiro.`,
    );
  }
  return reader;
}

/**
 * Inspects a database without creating it or retaining an open reader.
 * @param path - Local database path or the in-memory sentinel.
 * @param tableName - Logical table whose presence and row count should be inspected.
 * @returns File details and readiness; open and read failures are captured in the result.
 */
export async function inspectDatabase(
  path: string,
  tableName = SQLITE_CEP_TABLE_NAME,
): Promise<DatabaseInspection> {
  if (path === ':memory:' || !(await Bun.file(path).exists())) {
    return missingInspection(path);
  }

  let size: number | null = null;
  try {
    size = (await stat(path)).size;
  } catch {
    // SQLite will provide the useful open error below.
  }

  try {
    const binary = await isBinaryDatabase(path);
    const reader = binary ? new DneBinaryDatabaseReader(path) : new DneDatabaseReader(path);
    try {
      const binaryReader = reader instanceof DneBinaryDatabaseReader;
      const ready = binaryReader
        ? tableName === SQLITE_CEP_TABLE_NAME
        : reader.hasTable(tableName);
      return {
        exists: true,
        format: binary ? 'binary' : 'sqlite',
        metadata: reader.metadata(),
        path,
        ready,
        row_count: ready ? (binaryReader ? reader.rowCount() : reader.rowCount(tableName)) : null,
        schema: ready && !binaryReader ? reader.tableSchema(tableName) : null,
        size_bytes: size,
      };
    } finally {
      reader.close();
    }
  } catch (error) {
    return {
      ...missingInspection(path),
      error: errorMessage(error),
      exists: true,
      size_bytes: size,
    };
  }
}

/**
 * Creates an inspection summary for a completed in-memory load.
 * @param rowCount - Number of rows produced by the load.
 * @returns A summary without a persistent file, file size, or stored schema.
 */
export function memoryDatabaseInspection(rowCount: number): DatabaseInspection {
  return {
    ...missingInspection(':memory:'),
    row_count: rowCount,
  };
}

/**
 * Reads import metadata after detecting SQLite or binary storage.
 * @param path - Local database path.
 * @returns Metadata, or null for a missing file or absent SQLite metadata table.
 * @throws {DneBinaryDatabaseError} If a binary database cannot be accessed or decoded.
 * @throws {Error} If SQLite metadata cannot be read.
 */
export async function readDatabaseMetadata(path: string): Promise<LoadMetadata | null> {
  if (path !== ':memory:' && !(await Bun.file(path).exists())) {
    return null;
  }
  return await isBinaryDatabase(path)
    ? readBinaryDatabaseMetadata(path)
    : readSqliteDatabaseMetadata(path);
}

/**
 * Checks whether a local database exposes the requested logical table.
 * @param path - Local database path; missing files and `:memory:` return false.
 * @param tableName - Physical SQLite table name or the default binary CEP table name.
 * @returns Table presence. Binary detection checks the signature, not full file validity.
 * @throws {Error} If the file cannot be inspected.
 */
export async function hasTable(path: string, tableName: string): Promise<boolean> {
  if (path === ':memory:' || !(await Bun.file(path).exists())) {
    return false;
  }
  return await isBinaryDatabase(path)
    ? tableName === SQLITE_CEP_TABLE_NAME
    : hasSqliteTable(path, tableName);
}

function missingInspection(path: string): DatabaseInspection {
  return {
    exists: false,
    format: null,
    metadata: null,
    path,
    ready: false,
    row_count: null,
    schema: null,
    size_bytes: null,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
