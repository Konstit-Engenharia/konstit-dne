import { Database } from 'bun:sqlite';
import type { DneDataSource } from './dne-source.ts';
import {
  getTableFilesGlob,
  getUnifiedTable,
  type TableDefinition,
} from './schema.ts';
import {
  SQLITE_CACHE_SIZE,
  SQLITE_INSERT_BATCH_SIZE,
  SQLITE_METADATA_TABLE_NAME,
  SQLITE_PAGE_SIZE,
} from './settings.ts';

type InsertStatement = ReturnType<Database['prepare']>;
export type LoadMetadata = Record<string, string> & {
  package_version?: string;
  source_content_length?: string;
  source_etag?: string;
  source_kind?: string;
  source_last_modified?: string;
  source_url?: string;
};

export type DneRow = {
  bairro: string | null;
  cep: string;
  complemento: string | null;
  logradouro: string | null;
  municipio: string;
  municipio_cod_ibge: number;
  nome: string | null;
  uf: string;
};

export type LoadProgress = (message: string) => void;

export class DneDatabaseReader {
  private db: Database;

  constructor(databasePath: string) {
    this.db = new Database(databasePath, { readonly: true });
    this.db.run('PRAGMA busy_timeout = 30000');
  }

  close() {
    this.db.close();
  }

  hasTable(tableName: string) {
    return Boolean(this.db.query('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?').get(tableName));
  }

  metadata(): LoadMetadata | null {
    if (!this.hasTable(SQLITE_METADATA_TABLE_NAME)) {
      return null;
    }

    const rows = this.db.query(`SELECT key, value FROM ${quoteIdent(SQLITE_METADATA_TABLE_NAME)}`).all() as {
      key: string;
      value: string;
    }[];
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  queryCep(cepTableName: string, cep: string): DneRow | null {
    return this.db.query(`SELECT * FROM ${quoteIdent(cepTableName)} WHERE cep = ?`).get(cep) as DneRow | null;
  }

  rowCount(tableName: string) {
    const row = this.db.query(`SELECT count(*) AS count FROM ${quoteIdent(tableName)}`).get() as { count: number; };
    return row.count;
  }

  tableSchema(tableName: string) {
    const row = this.db.query('SELECT sql FROM sqlite_master WHERE type = \'table\' AND name = ?').get(tableName) as {
      sql: string | null;
    } | null;
    return row?.sql ?? null;
  }

  querySql(sql: string, limit: number) {
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
  }
}

type UnifiedInsertValue = string | number | null;
type UnifiedInsertRow = [
  cep: string,
  logradouro: string | null,
  complemento: string | null,
  bairro: string | null,
  municipio: string,
  municipioCodIbge: number | null,
  uf: string,
  nome: string | null,
];

type Localidade = {
  uf: string;
  nome: string;
  cep: string | null;
  locNuSub: string | null;
  munNu: number | null;
};

type UnifiedInsert = {
  run(...values: UnifiedInsertRow): void;
  flush(): void;
  finalize(): void;
};

class BatchedUnifiedInsert implements UnifiedInsert {
  private rows: UnifiedInsertRow[] = [];
  private statements = new Map<number, InsertStatement>();

  constructor(
    private db: Database,
    private tableName: string,
    private batchSize: number,
  ) {}

  run(...values: UnifiedInsertRow) {
    this.rows.push(values);
    if (this.rows.length >= this.batchSize) {
      this.flush();
    }
  }

  flush() {
    if (!this.rows.length) {
      return;
    }

    const rows = this.rows;
    this.rows = [];
    const params = Array.from({ length: rows.length * 8 }, () => null as UnifiedInsertValue);

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      if (!row) {
        throw new Error(`Missing row at index ${rowIndex}`);
      }
      const offset = rowIndex * 8;
      params[offset] = row[0];
      params[offset + 1] = row[1];
      params[offset + 2] = row[2];
      params[offset + 3] = row[3];
      params[offset + 4] = row[4];
      params[offset + 5] = row[5];
      params[offset + 6] = row[6];
      params[offset + 7] = row[7];
    }

    this.statementFor(rows.length).run(...params);
  }

  finalize() {
    for (const statement of this.statements.values()) {
      statement.finalize();
    }
    this.statements.clear();
  }

  private statementFor(rowCount: number) {
    let statement = this.statements.get(rowCount);
    if (statement) {
      return statement;
    }

    const placeholders = Array.from({ length: rowCount }, () => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    statement = this.db.prepare(`
      INSERT INTO ${quoteIdent(this.tableName)}
        (cep, logradouro, complemento, bairro, municipio, municipio_cod_ibge, uf, nome)
      VALUES ${placeholders}
    `);
    this.statements.set(rowCount, statement);
    return statement;
  }
}

export class DneDatabaseWriter {
  private db: Database;
  private tableByOriginalName: Map<string, TableDefinition>;
  private unifiedTable: TableDefinition;

  constructor(databasePath: string, schema: TableDefinition[]) {
    this.db = new Database(databasePath);
    this.tableByOriginalName = new Map(schema.map((table) => [table.originalName, table]));
    this.unifiedTable = getUnifiedTable(schema);
  }

  close() {
    this.db.run('PRAGMA locking_mode = NORMAL');
    // Disable persistent WAL (needed on macOS)
    // this.db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
    // Checkpoint and truncate the WAL file
    this.db.run('PRAGMA wal_checkpoint(TRUNCATE);');
    this.db.close();
  }

  async loadFromSource(source: DneDataSource, metadata: LoadMetadata = {}, onProgress: LoadProgress = () => {}) {
    const cepTable = this.unifiedTable;

    this.configureBulkLoad();
    await this.transaction(async () => {
      this.db.run(createTableSql(cepTable));
      this.createMetadataTable();
      this.db.run(`DELETE FROM ${quoteIdent(cepTable.name)}`);
      this.db.run(`DELETE FROM ${quoteIdent(SQLITE_METADATA_TABLE_NAME)}`);

      onProgress('Lendo municípios');
      const localidades = await this.readLocalidades(source);
      onProgress('Lendo bairros');
      const bairros = await this.readBairros(source);
      const insert = this.prepareUnifiedInsert(cepTable.name);

      onProgress('Carregando logradouros');
      await this.insertLogradouros(source, insert, localidades, bairros);
      onProgress('Carregando municípios');
      this.insertLocalidades(insert, localidades);
      this.insertLocalidadesSubordinadas(insert, localidades);
      onProgress('Carregando endereços especiais');
      await this.insertCpcs(source, insert, localidades);
      await this.insertGrandesUsuarios(source, insert, localidades, bairros);
      await this.insertUnidadesOperacionais(source, insert, localidades, bairros);
      insert.flush();
      insert.finalize();
      this.writeMetadata(metadata);
    });

    return this.rowCount(cepTable.name);
  }

  private async readLocalidades(source: DneDataSource) {
    const localidades = new Map<string, Localidade>();

    await this.forEachSelectedRow(this.originalTable('log_localidade'), source, [0, 1, 2, 3, 6, 8], (row) => {
      const [locNu, uf, nome, cep, locNuSub, munNu,] = row;
      if (!locNu || !uf || !nome) {
        return;
      }
      localidades.set(locNu, {
        uf,
        nome,
        cep: cep ?? null,
        locNuSub: locNuSub ?? null,
        munNu: munNu === null ? null : Number(munNu),
      });
    });

    return localidades;
  }

  private async readBairros(source: DneDataSource) {
    const bairros = new Map<string, string>();

    await this.forEachSelectedRow(this.originalTable('log_bairro'), source, [0, 3], (row) => {
      const [baiNu, bairro,] = row;
      if (baiNu && bairro) {
        bairros.set(baiNu, bairro);
      }
    });

    return bairros;
  }

  private prepareUnifiedInsert(tableName: string) {
    return new BatchedUnifiedInsert(this.db, tableName, SQLITE_INSERT_BATCH_SIZE);
  }

  private rowCount(tableName: string) {
    const row = this.db.query(`SELECT count(*) AS count FROM ${quoteIdent(tableName)}`).get() as { count: number; };
    return row.count;
  }

  private async insertLogradouros(
    source: DneDataSource,
    insert: UnifiedInsert,
    localidades: Map<string, Localidade>,
    bairros: Map<string, string>,
  ) {
    await this.forEachSelectedRow(this.originalTable('log_logradouro'), source, [1, 2, 3, 5, 7, 8, 9], (row) => {
      const [uf, locNu, baiNuIni, logNo, cep, tloTx, logStaTlo,] = row;
      const localidade = locNu ? localidades.get(locNu) : undefined;
      const bairro = baiNuIni ? bairros.get(baiNuIni) : undefined;
      if (!cep || !uf || !logNo || !localidade || !bairro) {
        return;
      }

      insert.run(
        cep,
        logStaTlo === 'S' ? `${tloTx} ${logNo}` : logNo,
        null,
        bairro,
        localidade.nome,
        localidade.munNu,
        uf,
        null,
      );
    });
  }

  private insertLocalidades(insert: UnifiedInsert, localidades: Map<string, Localidade>) {
    for (const localidade of localidades.values()) {
      if (localidade.cep && localidade.locNuSub === null && localidade.munNu !== null) {
        insert.run(localidade.cep, null, null, null, localidade.nome, localidade.munNu, localidade.uf, null);
      }
    }
  }

  private insertLocalidadesSubordinadas(insert: UnifiedInsert, localidades: Map<string, Localidade>) {
    for (const localidade of localidades.values()) {
      const parent = localidade.locNuSub ? localidades.get(localidade.locNuSub) : undefined;
      if (localidade.cep && parent?.munNu !== null && parent?.munNu !== undefined) {
        insert.run(localidade.cep, null, null, localidade.nome, parent.nome, parent.munNu, localidade.uf, null);
      }
    }
  }

  private async insertCpcs(source: DneDataSource, insert: UnifiedInsert, localidades: Map<string, Localidade>) {
    await this.forEachSelectedRow(this.originalTable('log_cpc'), source, [1, 2, 3, 4, 5], (row) => {
      const [uf, locNu, nome, endereco, cep,] = row;
      const localidade = locNu ? localidades.get(locNu) : undefined;
      if (!cep || !uf || !nome || !endereco || !localidade) {
        return;
      }

      const parent = localidade.locNuSub ? localidades.get(localidade.locNuSub) : undefined;
      const [logradouro, complemento,] = splitAddress(endereco);
      insert.run(
        cep,
        logradouro,
        complemento,
        null,
        parent?.nome ?? localidade.nome,
        parent?.munNu ?? localidade.munNu,
        uf,
        nome,
      );
    });
  }

  private async insertGrandesUsuarios(
    source: DneDataSource,
    insert: UnifiedInsert,
    localidades: Map<string, Localidade>,
    bairros: Map<string, string>,
  ) {
    await this.forEachSelectedRow(this.originalTable('log_grande_usuario'), source, [1, 2, 3, 5, 6, 7], (row) => {
      const [uf, locNu, baiNu, nome, endereco, cep,] = row;
      const localidade = locNu ? localidades.get(locNu) : undefined;
      const bairro = baiNu ? bairros.get(baiNu) : undefined;
      if (!cep || !uf || !nome || !endereco || !localidade || !bairro) {
        return;
      }

      const parent = localidade.locNuSub ? localidades.get(localidade.locNuSub) : undefined;
      const [logradouro, complemento,] = splitAddress(endereco);
      insert.run(
        cep,
        logradouro,
        complemento,
        bairro,
        parent?.nome ?? localidade.nome,
        parent?.munNu ?? localidade.munNu,
        uf,
        nome,
      );
    });
  }

  private async insertUnidadesOperacionais(
    source: DneDataSource,
    insert: UnifiedInsert,
    localidades: Map<string, Localidade>,
    bairros: Map<string, string>,
  ) {
    await this.forEachSelectedRow(this.originalTable('log_unid_oper'), source, [1, 2, 3, 5, 6, 7], (row) => {
      const [uf, locNu, baiNu, nome, endereco, cep,] = row;
      const localidade = locNu ? localidades.get(locNu) : undefined;
      const bairro = baiNu ? bairros.get(baiNu) : undefined;
      if (!cep || !uf || !nome || !endereco || !localidade || !bairro) {
        return;
      }

      const parent = localidade.locNuSub ? localidades.get(localidade.locNuSub) : undefined;
      const munNu = parent?.munNu ?? localidade.munNu;
      if (munNu === null) {
        return;
      }

      const [logradouro, complemento,] = splitAddress(endereco);
      insert.run(cep, logradouro, complemento, bairro, parent?.nome ?? localidade.nome, munNu, uf, nome);
    });
  }

  private async forEachSelectedRow(
    table: TableDefinition,
    source: DneDataSource,
    indexes: number[],
    fn: (row: (string | null)[]) => void,
  ) {
    const glob = getTableFilesGlob(table);
    if (!glob) {
      return;
    }

    for (const file of source.matchingFiles(glob)) {
      if (source.readText) {
        const content = await source.readText(file);
        forEachLine(content, (start, end) => fn(selectDelimitedFieldsInRange(content, start, end, indexes)));
        continue;
      }

      for await (const line of source.readLines(file)) {
        fn(selectDelimitedFields(line, indexes));
      }
    }
  }

  private originalTable(originalName: string) {
    const table = this.tableByOriginalName.get(originalName);
    if (!table) {
      throw new Error(`Table with original name '${originalName}' not found`);
    }
    return table;
  }

  private configureBulkLoad() {
    // Set database page size before data is written.
    this.db.run(`PRAGMA page_size = ${SQLITE_PAGE_SIZE}`);
    // Disable rollback journal writes; faster bulk load, no crash recovery.
    this.db.run('PRAGMA journal_mode = OFF');
    // Skip fsync calls; faster writes, but committed data can be lost on crash.
    this.db.run('PRAGMA synchronous = OFF');
    // Keep temporary tables and indexes in memory instead of disk.
    this.db.run('PRAGMA temp_store = MEMORY');
    // Hold an exclusive database lock for this connection.
    this.db.run('PRAGMA locking_mode = EXCLUSIVE');
    // Use about 200 MB of SQLite page cache.
    this.db.run(`PRAGMA cache_size = ${SQLITE_CACHE_SIZE}`);
  }

  private createMetadataTable() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS ${quoteIdent(SQLITE_METADATA_TABLE_NAME)} (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      )
    `);
  }

  private writeMetadata(metadata: LoadMetadata) {
    const insert = this.db.prepare(`INSERT INTO ${quoteIdent(SQLITE_METADATA_TABLE_NAME)} (key, value) VALUES (?, ?)`);
    try {
      for (const [key, value,] of Object.entries(metadata)) {
        insert.run(key, value);
      }
    } finally {
      insert.finalize();
    }
  }

  private async transaction(fn: () => Promise<void>) {
    this.db.run('BEGIN');
    try {
      await fn();
      this.db.run('COMMIT');
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    }
  }
}

export function createTableSql(table: TableDefinition) {
  return createTableSqlWithSeparator(table, ', ');
}

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
    if (column.comment) {
      parts.push(`/* ${column.comment} */`);
    }
    return parts.join(' ');
  });

  if (primaryKeys.length) {
    definitions.push(`PRIMARY KEY (${primaryKeys.join(', ')})`);
  }
  const withoutRowid = table.unifiedTable ? ' WITHOUT ROWID' : '';
  if (separator.includes('\n')) {
    return `CREATE TABLE IF NOT EXISTS ${quoteIdent(table.name)} (\n  ${definitions.join(separator)}\n)${withoutRowid}`;
  }
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(table.name)} (${definitions.join(separator)})${withoutRowid}`;
}

function splitAddress(value: string): [string, string | null] {
  const comma = value.indexOf(',');
  if (comma === -1) {
    return [value.trim(), null];
  }
  return [value.slice(0, comma).trim(), value.slice(comma + 1).trim()];
}

export function selectDelimitedFields(line: string, indexes: number[]) {
  return selectDelimitedFieldsInRange(line, 0, line.length, indexes);
}

function selectDelimitedFieldsInRange(line: string, lineStart: number, lineEnd: number, indexes: number[]) {
  const values = Array.from({ length: indexes.length }, () => null as string | null);
  let outputIndex = 0;
  let fieldIndex = 0;
  let start = lineStart;

  for (let offset = lineStart; offset <= lineEnd; offset++) {
    if (offset !== lineEnd && line.charCodeAt(offset) !== 64) {
      continue;
    }

    if (fieldIndex === indexes[outputIndex]) {
      values[outputIndex] = normalizeField(line, start, offset);
      outputIndex++;
      if (outputIndex === indexes.length) {
        break;
      }
    }

    fieldIndex++;
    start = offset + 1;
  }

  return values;
}

function forEachLine(content: string, fn: (start: number, end: number) => void) {
  let start = 0;

  for (let offset = 0; offset <= content.length; offset++) {
    if (offset !== content.length && content.charCodeAt(offset) !== 10) {
      continue;
    }

    let end = offset;
    if (end > start && content.charCodeAt(end - 1) === 13) {
      end--;
    }
    if (end > start) {
      fn(start, end);
    }
    start = offset + 1;
  }
}

function normalizeField(line: string, start: number, end: number) {
  if (start === end) {
    return null;
  }

  const first = line.charCodeAt(start);
  const last = line.charCodeAt(end - 1);
  const value = needsTrim(first) || needsTrim(last) ? line.slice(start, end).trim() : line.slice(start, end);
  return value === '' ? null : value;
}

function needsTrim(char: number) {
  return char <= 32 || char === 160;
}

export function quoteIdent(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export function sqlitePathFromDatabaseUrl(value: string) {
  if (!value.startsWith('sqlite:///')) {
    if (value.includes('://')) {
      throw new Error('Only sqlite:/// database URLs are supported');
    }
    return value;
  }
  return value.slice('sqlite:///'.length);
}

export async function readDatabaseMetadata(databasePath: string): Promise<LoadMetadata | null> {
  if (databasePath !== ':memory:' && !(await Bun.file(databasePath).exists())) {
    return null;
  }

  const db = new Database(databasePath, { readonly: true });
  try {
    const hasMetadata = db.query('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?').get(SQLITE_METADATA_TABLE_NAME);
    if (!hasMetadata) {
      return null;
    }

    const rows = db.query(`SELECT key, value FROM ${quoteIdent(SQLITE_METADATA_TABLE_NAME)}`).all() as {
      key: string;
      value: string;
    }[];
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  } finally {
    db.close();
  }
}

export async function hasTable(databasePath: string, tableName: string): Promise<boolean> {
  if (databasePath !== ':memory:' && !(await Bun.file(databasePath).exists())) {
    return false;
  }

  const db = new Database(databasePath, { readonly: true });
  try {
    return Boolean(db.query('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?').get(tableName));
  } finally {
    db.close();
  }
}
