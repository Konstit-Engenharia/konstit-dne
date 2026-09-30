import { Database } from 'bun:sqlite';
import {
  isBairroId,
  type DneBairro,
  type DneFaixaCep,
} from './bairro.ts';
import { cepToU32 } from './cep.ts';
import {
  LOCALIDADE_SITUACOES,
  LOCALIDADE_TIPO_CODIGOS,
  LOCALIDADE_TIPOS,
} from './schema.ts';
import {
  SQLITE_BAIRRO_FAIXAS_TABLE_NAME,
  SQLITE_BAIRROS_TABLE_NAME,
  SQLITE_CEP_TABLE_NAME,
  SQLITE_METADATA_TABLE_NAME,
} from './settings.ts';
import {
  DneDatabaseClosedError,
  DneDatabaseDataError,
  DneDatabaseError,
  DneDatabaseIOError,
  DneDatabaseQueryError,
  DneDatabaseSchemaError,
} from './sqlite-db-errors.ts';
import {
  cepViewName,
  quoteIdent,
} from './sqlite-db-schema.ts';
import type {
  DneRow,
  LoadMetadata,
  StoredDneRow,
} from './types.ts';

/** Error classes and discriminants used by the SQLite reader. */
export type { DneBairro, DneFaixaCep } from './bairro.ts';
export {
  DneDatabaseClosedError,
  DneDatabaseDataError,
  DneDatabaseError,
  type DneDatabaseErrorCode,
  DneDatabaseIOError,
  DneDatabaseQueryError,
  DneDatabaseSchemaError,
} from './sqlite-db-errors.ts';
export type { DneRow, LoadMetadata } from './types.ts';

/** Read-only SQLite access for CEP lookup, schema inspection, metadata, and bounded SQL queries. */
export class DneDatabaseReader {
  private readonly db: Database;
  private closed = false;
  private normalizedSchemaReady = false;

  /**
   * Opens an existing SQLite database in read-only mode with a 30-second busy timeout.
   * @param databasePath - Path to the SQLite database.
   * @throws {DneDatabaseIOError} If SQLite cannot open or configure the connection.
   */
  constructor(private readonly databasePath: string) {
    let db: Database | undefined;
    try {
      db = new Database(databasePath, { readonly: true });
      db.run('PRAGMA busy_timeout = 30000');
      this.db = db;
    } catch (cause) {
      try {
        db?.close();
      } catch {
        // Preserve the opening failure if cleanup also fails.
      }
      throw new DneDatabaseIOError(databasePath, { cause });
    }
  }

  /**
   * Closes the SQLite connection. Repeated calls are safe; subsequent reads throw.
   * @throws {DneDatabaseIOError} If SQLite cannot close the connection.
   */
  close() {
    if (this.closed) {
      return;
    }
    try {
      this.db.close();
      this.closed = true;
    } catch (cause) {
      throw new DneDatabaseIOError(this.databasePath, { cause });
    }
  }

  /**
   * Checks whether a named table exists in the database catalog.
   * @param tableName - Physical table name.
   * @returns True when the catalog contains a table with this name.
   * @throws {DneDatabaseClosedError} If the reader is closed, including for invalid input.
   * @throws {DneDatabaseQueryError} If SQLite cannot prepare or execute the read.
   */
  hasTable(tableName: string) {
    return this.readSafely(() => {
      return Boolean(this.db.query('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?').get(tableName));
    });
  }

  /**
   * Reads the import metadata table.
   * @returns A new metadata map, or undefined when the metadata table is absent.
   * @throws {DneDatabaseClosedError} If the reader is closed, including for invalid input.
   * @throws {DneDatabaseQueryError} If SQLite cannot prepare or execute the read.
   */
  metadata(): LoadMetadata | undefined {
    return this.readSafely(() => {
      if (!this.hasTable(SQLITE_METADATA_TABLE_NAME)) {
        return undefined;
      }

      const rows = this.db.query(`SELECT key, value FROM ${quoteIdent(SQLITE_METADATA_TABLE_NAME)}`).all() as {
        key: string;
        value: string;
      }[];
      return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    });
  }

  /**
   * Looks up a plain or hyphenated CEP in the default unified table.
   * @param cep - Eight ASCII digits or `NNNNN-NNN`, without surrounding whitespace.
   * @returns The matching address, or undefined for invalid input or a missing CEP.
   * @throws {DneDatabaseSchemaError} If normalized neighborhoods or locality fields are absent.
   * @throws {DneDatabaseDataError} If the matched row contains invalid locality indicators.
   * @throws {DneDatabaseClosedError} If the reader is closed, including for invalid input.
   * @throws {DneDatabaseQueryError} If SQLite cannot prepare or execute the read.
   */
  queryCep(cep: string): DneRow | undefined {
    return this.readSafely(() => {
      const parsed = cepToU32(cep);
      if (Number.isNaN(parsed)) {
        return undefined;
      }
      this.requireCurrentSchema();
      const row = this.db.query(`SELECT * FROM ${quoteIdent(cepViewName(SQLITE_CEP_TABLE_NAME))} WHERE cep = ?`)
        .get(cep.length === 8 ? cep : `${cep.slice(0, 5)}${cep.slice(6)}`) as StoredDneRow | null;
      if (!row) {
        return undefined;
      }
      if (row.localidade_situacao === undefined || row.localidade_tipo === undefined) {
        throw new DneDatabaseSchemaError('Database schema lacks locality indicators. Rebuild the database with build --force.');
      }
      const situacao = LOCALIDADE_SITUACOES[row.localidade_situacao];
      const tipo = LOCALIDADE_TIPOS[LOCALIDADE_TIPO_CODIGOS.indexOf(row.localidade_tipo)];
      if (situacao === undefined || tipo === undefined) {
        throw new DneDatabaseDataError('Database contains invalid locality indicators. Rebuild the database with build --force.');
      }
      return { ...row, localidade_situacao: situacao, localidade_tipo: tipo };
    });
  }

  /**
   * Reads a neighborhood by its original DNE identifier.
   * @param neighborhoodId - Positive `BAI_NU` identifier.
   * @returns The neighborhood, or undefined for an invalid or unknown identifier.
   * @throws {DneDatabaseSchemaError} If normalized neighborhoods are absent.
   * @throws {DneDatabaseClosedError} If the reader is closed, including for invalid input.
   * @throws {DneDatabaseQueryError} If SQLite cannot prepare or execute the read.
   */
  queryNeighborhood(neighborhoodId: number): DneBairro | undefined {
    return this.readSafely(() => {
      if (!isBairroId(neighborhoodId)) {
        return undefined;
      }
      this.requireCurrentSchema();
      const row = this.db.query(`SELECT * FROM ${quoteIdent(SQLITE_BAIRROS_TABLE_NAME)} WHERE bairro_id = ?`)
        .get(neighborhoodId) as DneBairro | null;
      return row ?? undefined;
    });
  }

  /**
   * Resolves the actual neighborhood attached to a CEP, without treating a district or village as a neighborhood.
   * @param cep - Eight ASCII digits or `NNNNN-NNN`.
   * @returns The neighborhood, or undefined for an invalid, unknown, or neighborhood-free CEP.
   * @throws {DneDatabaseSchemaError} If normalized neighborhoods are absent.
   * @throws {DneDatabaseClosedError} If the reader is closed, including for invalid input.
   * @throws {DneDatabaseQueryError} If SQLite cannot prepare or execute the read.
   */
  queryNeighborhoodByCep(cep: string): DneBairro | undefined {
    return this.readSafely(() => {
      if (Number.isNaN(cepToU32(cep))) {
        return undefined;
      }
      this.requireCurrentSchema();
      const row = this.db.query(`
        SELECT b.* FROM ${quoteIdent(SQLITE_CEP_TABLE_NAME)} d
        JOIN ${quoteIdent(SQLITE_BAIRROS_TABLE_NAME)} b ON b.bairro_id = d.bairro_id
        WHERE d.cep = ?
      `).get(cep.replace('-', '')) as DneBairro | null;
      return row ?? undefined;
    });
  }

  /**
   * Lists a neighborhood's original CEP intervals without merging gaps.
   * @param neighborhoodId - Positive `BAI_NU` identifier.
   * @returns Intervals sorted by their lower and upper bounds; an empty array for invalid, unknown, or rangeless neighborhoods.
   * @throws {DneDatabaseSchemaError} If normalized neighborhoods are absent.
   * @throws {DneDatabaseClosedError} If the reader is closed, including for invalid input.
   * @throws {DneDatabaseQueryError} If SQLite cannot prepare or execute the read.
   */
  queryNeighborhoodCepRanges(neighborhoodId: number): DneFaixaCep[] {
    return this.readSafely(() => {
      if (!isBairroId(neighborhoodId)) {
        return [];
      }
      this.requireCurrentSchema();
      return this.db.query(`
        SELECT cep_inicial, cep_final FROM ${quoteIdent(SQLITE_BAIRRO_FAIXAS_TABLE_NAME)}
        WHERE bairro_id = ? ORDER BY cep_inicial, cep_final
      `).all(neighborhoodId) as DneFaixaCep[];
    });
  }

  private requireCurrentSchema() {
    if (!this.normalizedSchemaReady) {
      this.normalizedSchemaReady = Boolean(
        this.db.query('SELECT 1 FROM sqlite_master WHERE type = \'view\' AND name = ?')
          .get(cepViewName(SQLITE_CEP_TABLE_NAME)),
      );
    }
    if (!this.normalizedSchemaReady) {
      throw new DneDatabaseSchemaError('Database schema lacks normalized neighborhoods. Rebuild the database with build --force.');
    }
  }

  /**
   * Counts all rows in a SQLite table.
   * @param tableName - Existing physical table name.
   * @returns The number of rows reported by SQLite.
   * @throws {DneDatabaseClosedError} If the reader is closed, including for invalid input.
   * @throws {DneDatabaseQueryError} If SQLite cannot prepare or execute the read.
   */
  rowCount(tableName: string) {
    return this.readSafely(() => {
      const row = this.db.query(`SELECT count(*) AS count FROM ${quoteIdent(tableName)}`).get() as { count: number; };
      return row.count;
    });
  }

  /**
   * Reads a table's stored CREATE statement without reconstructing it from the declared schema.
   * @param tableName - Physical table name.
   * @returns The catalog SQL, or undefined when no SQL definition is available.
   * @throws {DneDatabaseClosedError} If the reader is closed, including for invalid input.
   * @throws {DneDatabaseQueryError} If SQLite cannot prepare or execute the read.
   */
  tableSchema(tableName: string) {
    return this.readSafely(() => {
      const row = this.db.query('SELECT sql FROM sqlite_master WHERE type = \'table\' AND name = ?').get(tableName) as {
        sql: string | null;
      } | null;
      return row?.sql ?? undefined;
    });
  }

  /**
   * Executes caller-supplied SQL on the read-only connection, retaining a bounded result.
   * @param sql - A statement accepted by SQLite; this method does not apply the CLI's statement filter.
   * @param limit - Positive maximum number of rows to retain.
   * @returns Rows plus a flag indicating whether at least one additional row was available.
   * @throws {DneDatabaseClosedError} If the reader is closed, including for invalid input.
   * @throws {DneDatabaseQueryError} If SQLite cannot prepare or execute the read.
   */
  querySql(sql: string, limit: number) {
    return this.readSafely(() => {
      const rows: Record<string, unknown>[] = [];
      const statement = this.db.query(sql);

      try {
        for (const value of statement.iterate()) {
          rows.push(value as Record<string, unknown>);
          if (rows.length > limit) {
            break;
          }
        }
      } finally {
        statement.finalize();
      }

      return {
        rows: rows.slice(0, limit),
        truncated: rows.length > limit,
      };
    });
  }

  private readSafely<T>(read: () => T): T {
    if (this.closed) {
      throw new DneDatabaseClosedError();
    }
    try {
      return read();
    } catch (cause) {
      if (cause instanceof DneDatabaseError) {
        throw cause;
      }
      throw new DneDatabaseQueryError(cause instanceof Error ? cause.message : String(cause), { cause });
    }
  }
}

/**
 * Converts a supported SQLite URL to its path without resolving relative paths.
 * @param value - Plain path, `:memory:`, or a URL beginning with `sqlite:///`.
 * @returns The path after removing the supported URL prefix, without URI decoding.
 * @throws {Error} If a different URL scheme is supplied.
 */
export function sqlitePathFromDatabaseUrl(value: string) {
  if (!value.startsWith('sqlite:///')) {
    if (value.includes('://')) {
      throw new Error('Only sqlite:/// database URLs are supported');
    }
    return value;
  }
  return value.slice('sqlite:///'.length);
}

/**
 * Reads SQLite load metadata using a temporary read-only connection.
 * @param databasePath - Path to the SQLite database.
 * @returns Metadata, or undefined if the file or metadata table is missing.
 * @throws {DneDatabaseIOError} If an existing database cannot be opened or closed.
 * @throws {DneDatabaseQueryError} If its metadata cannot be queried.
 */
export async function readDatabaseMetadata(databasePath: string): Promise<LoadMetadata | undefined> {
  if (databasePath !== ':memory:' && !(await Bun.file(databasePath).exists())) {
    return undefined;
  }

  const reader = new DneDatabaseReader(databasePath);
  try {
    return reader.metadata();
  } finally {
    reader.close();
  }
}

/**
 * Checks for a SQLite table without creating a missing database.
 * @param databasePath - Database file path; `:memory:` reports false.
 * @param tableName - Physical table name to locate.
 * @returns False for a missing database or table.
 * @throws {DneDatabaseIOError} If an existing database cannot be opened or closed.
 * @throws {DneDatabaseQueryError} If its catalog cannot be queried.
 */
export async function hasTable(databasePath: string, tableName: string): Promise<boolean> {
  if (databasePath !== ':memory:' && !(await Bun.file(databasePath).exists())) {
    return false;
  }

  const reader = new DneDatabaseReader(databasePath);
  try {
    return reader.hasTable(tableName);
  } finally {
    reader.close();
  }
}
