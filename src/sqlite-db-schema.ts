import type { Database } from 'bun:sqlite';
import {
  getStoredTables,
  getUnifiedTable,
  type TableDefinition,
} from './schema.ts';
import { SQLITE_BAIRROS_TABLE_NAME } from './settings.ts';

/**
 * Creates a generated table, replacing it when its column names, order, or types differ.
 * Call inside a transaction: replacing the table discards its current contents and indexes.
 * @param db - Writable SQLite connection owned by the caller.
 * @param table - Expected generated table definition.
 * @throws {Error} If catalog inspection or schema creation fails.
 */
export function prepareTableForLoad(db: Database, table: TableDefinition) {
  const columns = db.query(`PRAGMA table_info(${quoteIdent(table.name)})`).all() as { name: string; type: string; }[];
  const definition = db.query('SELECT sql FROM sqlite_master WHERE type = \'table\' AND name = ?').get(table.name) as {
    sql: string;
  } | null;
  if (
    columns.length && (
      columns.length !== table.columns.length
      || columns.some((column, index) => column.name !== table.columns[index]?.name || column.type !== table.columns[index]?.type)
      || table.columns.some((column) => column.check && !definition?.sql.includes(`CHECK (${column.check})`))
    )
  ) {
    db.run(`DROP TABLE ${quoteIdent(table.name)}`);
  }
  db.run(createTableSql(table));
}

/**
 * Generates a single-line CREATE TABLE IF NOT EXISTS statement, including constraints.
 * @param table - Trusted table and column definitions.
 * @returns SQL using WITHOUT ROWID for a unified table.
 */
export function createTableSql(table: TableDefinition) {
  return createTableSqlWithSeparator(table, ', ');
}

/**
 * Generates a multiline CREATE TABLE statement for display and documentation.
 * @param table - Trusted table and column definitions.
 * @returns The same schema as `createTableSql`, with one definition per line.
 */
export function createPrettyTableSql(table: TableDefinition) {
  return createTableSqlWithSeparator(table, ',\n  ');
}

function createTableSqlWithSeparator(table: TableDefinition, separator: string) {
  const primaryKeys = table.columns.filter((column) => column.primaryKey).map((column) => quoteIdent(column.name));
  const definitions = table.columns.map((column) => {
    const parts = [quoteIdent(column.name), column.type];
    if (column.notNull || column.primaryKey) {
      parts.push('NOT NULL');
    }
    if (column.check) {
      parts.push(`CHECK (${column.check})`);
    }
    if (column.references) {
      parts.push(`REFERENCES ${quoteIdent(column.references.table)} (${quoteIdent(column.references.column)})`);
    }
    if (column.comment) {
      parts.push(`/* ${column.comment} */`);
    }
    return parts.join(' ');
  });

  if (primaryKeys.length) {
    definitions.push(`PRIMARY KEY (${primaryKeys.join(', ')})`);
  }
  const withoutRowid = (table.withoutRowid ?? table.unifiedTable) ? ' WITHOUT ROWID' : '';
  if (separator.includes('\n')) {
    return `CREATE TABLE IF NOT EXISTS ${quoteIdent(table.name)} (\n  ${definitions.join(separator)}\n)${withoutRowid}`;
  }
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(table.name)} (${definitions.join(separator)})${withoutRowid}`;
}

/**
 * Resolves the address projection that retains the public CEP lookup columns.
 * @param tableName - Physical normalized address table name.
 * @returns The corresponding view name.
 */
export function cepViewName(tableName: string): string {
  return `${tableName}_consulta`;
}

/**
 * Creates the view that resolves neighborhood names and subordinate locality names.
 * @param tableName - Physical normalized address table name.
 * @param bairrosTableName - Physical neighborhood table name.
 * @returns A quoted CREATE VIEW statement with the existing ten public address columns.
 */
export function createCepViewSql(tableName: string, bairrosTableName = SQLITE_BAIRROS_TABLE_NAME): string {
  return `CREATE VIEW ${quoteIdent(cepViewName(tableName))} AS
    SELECT d.cep, d.logradouro, d.complemento, COALESCE(b.nome, d.localidade_nome) AS bairro,
      d.municipio, d.municipio_cod_ibge, d.uf, d.nome, d.localidade_situacao, d.localidade_tipo
    FROM ${quoteIdent(tableName)} d
    LEFT JOIN ${quoteIdent(bairrosTableName)} b ON b.bairro_id = d.bairro_id`;
}

/**
 * Recreates the owned address, neighborhood, and interval tables inside the caller's transaction.
 * Unrelated tables are retained. The transaction must be rolled back if importing or copying data fails.
 * @param db - Writable SQLite connection with foreign keys enabled.
 * @param schema - Source mappings and persisted table definitions.
 * @throws {Error} If a required table definition is missing or SQLite rejects a schema operation.
 */
export function prepareDatabaseForLoad(db: Database, schema: readonly TableDefinition[]): void {
  const cepTable = getUnifiedTable(schema);
  const bairros = schema.find((table) => table.originalName === 'bairros');
  if (!bairros) {
    throw new Error('Neighborhood table definition is missing');
  }
  const stored = getStoredTables(schema);
  db.run(`DROP VIEW IF EXISTS main.${quoteIdent(cepViewName(cepTable.name))}`);
  for (const table of [...stored].reverse()) {
    db.run(`DROP TABLE IF EXISTS main.${quoteIdent(table.name)}`);
  }
  for (const table of stored) {
    db.run(createTableSql(table));
  }
  db.run(createCepViewSql(cepTable.name, bairros.name));
}

/**
 * Quotes a SQLite identifier, escaping embedded double quotes.
 * @param value - One identifier, not a dotted SQL expression.
 * @returns A double-quoted identifier safe to interpolate into SQL.
 */
export function quoteIdent(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}
