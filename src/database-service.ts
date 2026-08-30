import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  DneDatabaseReader,
  sqlitePathFromDatabaseUrl,
  type LoadMetadata,
} from './db.ts';
import { UserError } from './errors.ts';
import { SQLITE_CEP_TABLE_NAME } from './settings.ts';

export type DatabaseInspection = {
  error?: string;
  exists: boolean;
  metadata: LoadMetadata | null;
  path: string;
  ready: boolean;
  row_count: number | null;
  schema: string | null;
  size_bytes: number | null;
};

export function databasePath(value: string) {
  const path = sqlitePathFromDatabaseUrl(value);
  return path === ':memory:' ? path : resolve(path);
}

export async function openReadyDatabase(path: string, tableName = SQLITE_CEP_TABLE_NAME) {
  if (path === ':memory:' || !(await Bun.file(path).exists())) {
    throw new UserError('database-not-found', `Base não encontrada: ${path}`);
  }

  let reader: DneDatabaseReader;
  try {
    reader = new DneDatabaseReader(path);
  } catch (error) {
    throw new UserError('database-invalid', `Não foi possível abrir a base '${path}': ${errorMessage(error)}`);
  }

  if (!reader.hasTable(tableName)) {
    reader.close();
    throw new UserError(
      'database-not-ready',
      `A base '${path}' não contém a tabela '${tableName}'. Execute bunx @konstit/dne build primeiro.`,
    );
  }
  return reader;
}

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
    const reader = new DneDatabaseReader(path);
    try {
      const ready = reader.hasTable(tableName);
      return {
        exists: true,
        metadata: reader.metadata(),
        path,
        ready,
        row_count: ready ? reader.rowCount(tableName) : null,
        schema: ready ? reader.tableSchema(tableName) : null,
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

export function memoryDatabaseInspection(rowCount: number): DatabaseInspection {
  return {
    ...missingInspection(':memory:'),
    row_count: rowCount,
  };
}

function missingInspection(path: string): DatabaseInspection {
  return {
    exists: false,
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
