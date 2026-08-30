import { Database } from 'bun:sqlite';
import type { DneDataSource } from './dne-source.ts';
import {
  getSourceFieldIndexes,
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

export class DneSourceQualityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DneSourceQualityError';
  }
}

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
  municipioCodIbge: number,
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

type LocalidadeCandidate = Localidade & {
  quality: LoadQualityCounter;
};

type Bairro = {
  uf: string;
  locNu: string;
  nome: string;
};

export type LoadQualityCounts = {
  read: number;
  accepted: number;
  rejected: number;
};

export type LoadQualityBreakdown = LoadQualityCounts & {
  rejection_reasons: Record<string, number>;
};

export type LoadQualityStage = LoadQualityBreakdown & {
  files: Record<string, LoadQualityBreakdown>;
};

export type LoadQualityReport = {
  version: 1;
  status: 'passed';
  output_rows: number;
  totals: LoadQualityCounts;
  stages: Record<string, LoadQualityStage>;
};

type MutableQualityBreakdown = {
  read: number;
  accepted: number;
  rejected: number;
  rejectionReasons: Map<string, number>;
};

type MutableQualityStage = MutableQualityBreakdown & {
  files: Map<string, MutableQualityBreakdown>;
};

type LoadQualityCounter = {
  read(): void;
  accept(): void;
  reject(reason: string): void;
};

class LoadQualityTracker {
  private stages = new Map<string, MutableQualityStage>();

  counter(stageName: string, fileName: string): LoadQualityCounter {
    const stage = this.stage(stageName);
    const file = this.file(stageName, fileName);
    return {
      read() {
        stage.read++;
        file.read++;
      },
      accept() {
        stage.accepted++;
        file.accepted++;
      },
      reject(reason: string) {
        stage.rejected++;
        file.rejected++;
        incrementReason(stage.rejectionReasons, reason);
        incrementReason(file.rejectionReasons, reason);
      },
    };
  }

  assertValid() {
    const rejected = Array.from(this.stages.values()).reduce((total, stage) => total + stage.rejected, 0);
    if (!rejected) {
      return;
    }

    const reasons = new Map<string, number>();
    for (const stage of this.stages.values()) {
      for (const [reason, count,] of stage.rejectionReasons) {
        reasons.set(reason, (reasons.get(reason) ?? 0) + count);
      }
    }
    const summary = Array.from(reasons).map(([reason, count,]) => `${reason}=${count}`).join(', ');
    throw new DneSourceQualityError(`DNE source quality validation failed: ${rejected} rejected row(s) (${summary})`);
  }

  report(outputRows: number): LoadQualityReport {
    const totals: LoadQualityCounts = { read: 0, accepted: 0, rejected: 0 };
    const stages: Record<string, LoadQualityStage> = {};

    for (const [name, stage,] of this.stages) {
      totals.read += stage.read;
      totals.accepted += stage.accepted;
      totals.rejected += stage.rejected;
      const files: Record<string, LoadQualityBreakdown> = {};
      for (const [file, counts,] of stage.files) {
        files[file] = qualityBreakdown(counts);
      }
      stages[name] = { ...qualityBreakdown(stage), files };
    }

    return {
      version: 1,
      status: 'passed',
      output_rows: outputRows,
      totals,
      stages,
    };
  }

  private stage(name: string): MutableQualityStage {
    let stage = this.stages.get(name);
    if (!stage) {
      stage = { ...newQualityBreakdown(), files: new Map() };
      this.stages.set(name, stage);
    }
    return stage;
  }

  private file(stageName: string, fileName: string): MutableQualityBreakdown {
    const stage = this.stage(stageName);
    let file = stage.files.get(fileName);
    if (!file) {
      file = newQualityBreakdown();
      stage.files.set(fileName, file);
    }
    return file;
  }
}

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
    const quality = new LoadQualityTracker();

    this.configureBulkLoad();
    await this.transaction(async () => {
      this.db.run(createTableSql(cepTable));
      this.createMetadataTable();
      this.db.run(`DELETE FROM ${quoteIdent(cepTable.name)}`);
      this.db.run(`DELETE FROM ${quoteIdent(SQLITE_METADATA_TABLE_NAME)}`);

      onProgress('Lendo municípios');
      const localidades = await this.readLocalidades(source, quality);
      onProgress('Lendo bairros');
      const bairros = await this.readBairros(source, localidades, quality);
      const insert = this.prepareUnifiedInsert(cepTable.name);

      try {
        onProgress('Carregando logradouros');
        await this.insertLogradouros(source, insert, localidades, bairros, quality);
        onProgress('Carregando municípios');
        this.insertLocalidades(insert, localidades);
        this.insertLocalidadesSubordinadas(insert, localidades);
        onProgress('Carregando endereços especiais');
        await this.insertCpcs(source, insert, localidades, quality);
        await this.insertGrandesUsuarios(source, insert, localidades, bairros, quality);
        await this.insertUnidadesOperacionais(source, insert, localidades, bairros, quality);
        quality.assertValid();
        if (!localidades.size) {
          throw new DneSourceQualityError('DNE source quality validation failed: no accepted localidade rows');
        }
        insert.flush();

        const outputRows = this.rowCount(cepTable.name);
        if (!outputRows) {
          throw new DneSourceQualityError('DNE source quality validation failed: no CEP rows produced');
        }
        const report = quality.report(outputRows);
        this.writeMetadata({
          ...metadata,
          quality_report: JSON.stringify(report),
          quality_rows_accepted: String(report.totals.accepted),
          quality_rows_read: String(report.totals.read),
          quality_rows_rejected: String(report.totals.rejected),
        });
      } finally {
        insert.finalize();
      }
    });

    return this.rowCount(cepTable.name);
  }

  private async readLocalidades(source: DneDataSource, quality: LoadQualityTracker) {
    const table = this.originalTable('log_localidade');
    const candidates = new Map<string, LocalidadeCandidate>();

    await this.forEachSelectedRow(
      table,
      source,
      getSourceFieldIndexes(table, ['locNu', 'uf', 'nome', 'cep', 'locNuSub', 'munNu']),
      quality,
      (row, _file, counter) => {
        const [locNu = null, uf = null, nome = null, cep = null, locNuSub = null, munNuRaw = null,] = row;
        const requiredProblem = missingRequiredField([
          ['locNu', locNu],
          ['uf', uf],
          ['nome', nome],
        ]);
        if (requiredProblem || !locNu || !uf || !nome) {
          counter.reject(requiredProblem ?? 'invalid_structure');
          return;
        }
        if (!isBrazilianUf(uf)) {
          counter.reject('invalid_uf');
          return;
        }
        if (cep !== null && !isValidCep(cep)) {
          counter.reject('invalid_cep');
          return;
        }
        if (munNuRaw !== null && !isValidIbgeInteger(munNuRaw)) {
          counter.reject('invalid_ibge');
          return;
        }
        if (candidates.has(locNu)) {
          counter.reject('duplicate_localidade');
          return;
        }

        candidates.set(locNu, {
          uf,
          nome,
          cep,
          locNuSub,
          munNu: munNuRaw === null ? null : Number(munNuRaw),
          quality: counter,
        });
      },
    );

    const localidades = new Map<string, Localidade>();
    for (const [locNu, candidate,] of candidates) {
      const parent = candidate.locNuSub ? candidates.get(candidate.locNuSub) : undefined;
      if (candidate.locNuSub && (!parent || parent.munNu === null)) {
        candidate.quality.reject('missing_parent_localidade');
        continue;
      }
      if (parent && parent.uf !== candidate.uf) {
        candidate.quality.reject('localidade_uf_mismatch');
        continue;
      }
      if (!candidate.locNuSub && candidate.munNu === null) {
        candidate.quality.reject('missing_ibge');
        continue;
      }

      localidades.set(locNu, candidate);
      candidate.quality.accept();
    }

    return localidades;
  }

  private async readBairros(
    source: DneDataSource,
    localidades: Map<string, Localidade>,
    quality: LoadQualityTracker,
  ) {
    const table = this.originalTable('log_bairro');
    const bairros = new Map<string, Bairro>();

    await this.forEachSelectedRow(
      table,
      source,
      getSourceFieldIndexes(table, ['baiNu', 'uf', 'locNu', 'bairro']),
      quality,
      (row, _file, counter) => {
        const [baiNu = null, uf = null, locNu = null, bairro = null,] = row;
        const requiredProblem = missingRequiredField([
          ['baiNu', baiNu],
          ['uf', uf],
          ['locNu', locNu],
          ['bairro', bairro],
        ]);
        if (requiredProblem || !baiNu || !uf || !locNu || !bairro) {
          counter.reject(requiredProblem ?? 'invalid_structure');
          return;
        }
        if (!isBrazilianUf(uf)) {
          counter.reject('invalid_uf');
          return;
        }
        const localidade = localidades.get(locNu);
        if (!localidade) {
          counter.reject('missing_localidade');
          return;
        }
        if (localidade.uf !== uf) {
          counter.reject('bairro_uf_mismatch');
          return;
        }
        if (bairros.has(baiNu)) {
          counter.reject('duplicate_bairro');
          return;
        }

        bairros.set(baiNu, { uf, locNu, nome: bairro });
        counter.accept();
      },
    );

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
    bairros: Map<string, Bairro>,
    quality: LoadQualityTracker,
  ) {
    const table = this.originalTable('log_logradouro');

    await this.forEachSelectedRow(
      table,
      source,
      getSourceFieldIndexes(table, ['uf', 'locNu', 'baiNuIni', 'logNo', 'cep', 'tloTx', 'logStaTlo']),
      quality,
      (row, _file, counter) => {
        const [
          uf = null,
          locNu = null,
          baiNuIni = null,
          logNo = null,
          cep = null,
          tloTx = null,
          logStaTlo = null,
        ] = row;
        const requiredProblem = missingRequiredField([
          ['uf', uf],
          ['locNu', locNu],
          ['baiNuIni', baiNuIni],
          ['logNo', logNo],
          ['cep', cep],
        ]);
        if (requiredProblem || !uf || !locNu || !baiNuIni || !logNo || !cep) {
          counter.reject(requiredProblem ?? 'invalid_structure');
          return;
        }
        if (!isBrazilianUf(uf)) {
          counter.reject('invalid_uf');
          return;
        }
        if (!isValidCep(cep)) {
          counter.reject('invalid_cep');
          return;
        }
        if (logStaTlo === 'S' && !tloTx) {
          counter.reject('missing_tloTx');
          return;
        }

        const localidade = localidades.get(locNu);
        if (!localidade) {
          counter.reject('missing_localidade');
          return;
        }
        const bairro = bairros.get(baiNuIni);
        if (!bairro) {
          counter.reject('missing_bairro');
          return;
        }
        if (localidade.uf !== uf || bairro.uf !== uf) {
          counter.reject('logradouro_uf_mismatch');
          return;
        }
        if (bairro.locNu !== locNu) {
          counter.reject('bairro_localidade_mismatch');
          return;
        }
        const municipality = resolveMunicipality(localidade, localidades);
        if (!municipality) {
          counter.reject('missing_municipality');
          return;
        }

        insert.run(
          cep,
          logStaTlo === 'S' ? `${tloTx} ${logNo}` : logNo,
          null,
          bairro.nome,
          municipality.nome,
          municipality.munNu,
          uf,
          null,
        );
        counter.accept();
      },
    );
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

  private async insertCpcs(
    source: DneDataSource,
    insert: UnifiedInsert,
    localidades: Map<string, Localidade>,
    quality: LoadQualityTracker,
  ) {
    const table = this.originalTable('log_cpc');

    await this.forEachSelectedRow(
      table,
      source,
      getSourceFieldIndexes(table, ['uf', 'locNu', 'nome', 'endereco', 'cep']),
      quality,
      (row, _file, counter) => {
        const [uf = null, locNu = null, nome = null, endereco = null, cep = null,] = row;
        const requiredProblem = missingRequiredField([
          ['uf', uf],
          ['locNu', locNu],
          ['nome', nome],
          ['endereco', endereco],
          ['cep', cep],
        ]);
        if (requiredProblem || !uf || !locNu || !nome || !endereco || !cep) {
          counter.reject(requiredProblem ?? 'invalid_structure');
          return;
        }
        if (!isBrazilianUf(uf)) {
          counter.reject('invalid_uf');
          return;
        }
        if (!isValidCep(cep)) {
          counter.reject('invalid_cep');
          return;
        }
        const localidade = localidades.get(locNu);
        if (!localidade) {
          counter.reject('missing_localidade');
          return;
        }
        if (localidade.uf !== uf) {
          counter.reject('cpc_uf_mismatch');
          return;
        }
        const municipality = resolveMunicipality(localidade, localidades);
        if (!municipality) {
          counter.reject('missing_municipality');
          return;
        }

        const [logradouro, complemento,] = splitAddress(endereco);
        insert.run(cep, logradouro, complemento, null, municipality.nome, municipality.munNu, uf, nome);
        counter.accept();
      },
    );
  }

  private async insertGrandesUsuarios(
    source: DneDataSource,
    insert: UnifiedInsert,
    localidades: Map<string, Localidade>,
    bairros: Map<string, Bairro>,
    quality: LoadQualityTracker,
  ) {
    await this.insertNamedAddresses(
      this.originalTable('log_grande_usuario'),
      source,
      insert,
      localidades,
      bairros,
      quality,
    );
  }

  private async insertUnidadesOperacionais(
    source: DneDataSource,
    insert: UnifiedInsert,
    localidades: Map<string, Localidade>,
    bairros: Map<string, Bairro>,
    quality: LoadQualityTracker,
  ) {
    await this.insertNamedAddresses(
      this.originalTable('log_unid_oper'),
      source,
      insert,
      localidades,
      bairros,
      quality,
    );
  }

  private async insertNamedAddresses(
    table: TableDefinition,
    source: DneDataSource,
    insert: UnifiedInsert,
    localidades: Map<string, Localidade>,
    bairros: Map<string, Bairro>,
    quality: LoadQualityTracker,
  ) {
    await this.forEachSelectedRow(
      table,
      source,
      getSourceFieldIndexes(table, ['uf', 'locNu', 'baiNu', 'nome', 'endereco', 'cep']),
      quality,
      (row, _file, counter) => {
        const [uf = null, locNu = null, baiNu = null, nome = null, endereco = null, cep = null,] = row;
        const requiredProblem = missingRequiredField([
          ['uf', uf],
          ['locNu', locNu],
          ['baiNu', baiNu],
          ['nome', nome],
          ['endereco', endereco],
          ['cep', cep],
        ]);
        if (requiredProblem || !uf || !locNu || !baiNu || !nome || !endereco || !cep) {
          counter.reject(requiredProblem ?? 'invalid_structure');
          return;
        }
        if (!isBrazilianUf(uf)) {
          counter.reject('invalid_uf');
          return;
        }
        if (!isValidCep(cep)) {
          counter.reject('invalid_cep');
          return;
        }
        const localidade = localidades.get(locNu);
        if (!localidade) {
          counter.reject('missing_localidade');
          return;
        }
        const bairro = bairros.get(baiNu);
        if (!bairro) {
          counter.reject('missing_bairro');
          return;
        }
        if (localidade.uf !== uf || bairro.uf !== uf) {
          counter.reject('address_uf_mismatch');
          return;
        }
        if (bairro.locNu !== locNu) {
          counter.reject('bairro_localidade_mismatch');
          return;
        }
        const municipality = resolveMunicipality(localidade, localidades);
        if (!municipality) {
          counter.reject('missing_municipality');
          return;
        }

        const [logradouro, complemento,] = splitAddress(endereco);
        insert.run(cep, logradouro, complemento, bairro.nome, municipality.nome, municipality.munNu, uf, nome);
        counter.accept();
      },
    );
  }

  private async forEachSelectedRow(
    table: TableDefinition,
    source: DneDataSource,
    indexes: number[],
    quality: LoadQualityTracker,
    fn: (row: (string | null)[], file: string, counter: LoadQualityCounter) => void,
  ) {
    const glob = getTableFilesGlob(table);
    if (!glob) {
      return;
    }

    const files = source.matchingFiles(glob);
    if (!files.length) {
      throw new Error(`DNE data file not found: ${glob}`);
    }

    for (const file of files) {
      const counter = quality.counter(table.originalName, file);
      if (source.readText) {
        const content = await source.readText(file);
        forEachLine(content, (start, end) => {
          counter.read();
          fn(selectDelimitedFieldsInRange(content, start, end, indexes), file, counter);
        });
        continue;
      }

      for await (const line of source.readLines(file)) {
        counter.read();
        fn(selectDelimitedFields(line, indexes), file, counter);
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

const BRAZILIAN_UFS = new Set([
  'AC',
  'AL',
  'AM',
  'AP',
  'BA',
  'CE',
  'DF',
  'ES',
  'GO',
  'MA',
  'MG',
  'MS',
  'MT',
  'PA',
  'PB',
  'PE',
  'PI',
  'PR',
  'RJ',
  'RN',
  'RO',
  'RR',
  'RS',
  'SC',
  'SE',
  'SP',
  'TO',
]);

function isBrazilianUf(value: string | null): value is string {
  return value !== null && BRAZILIAN_UFS.has(value);
}

function isValidCep(value: string | null): value is string {
  return value !== null && /^\d{8}$/.test(value);
}

function isValidIbgeInteger(value: string) {
  if (!/^\d{7}$/.test(value)) {
    return false;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

function missingRequiredField(fields: [name: string, value: string | null][]) {
  const missing = fields.find(([, value,]) => value === null);
  return missing ? `missing_${missing[0]}` : null;
}

function resolveMunicipality(
  localidade: Localidade,
  localidades: Map<string, Localidade>,
): { nome: string; munNu: number; } | null {
  const municipality = localidade.locNuSub ? localidades.get(localidade.locNuSub) : localidade;
  if (!municipality || municipality.munNu === null) {
    return null;
  }
  return { nome: municipality.nome, munNu: municipality.munNu };
}

function newQualityBreakdown(): MutableQualityBreakdown {
  return {
    read: 0,
    accepted: 0,
    rejected: 0,
    rejectionReasons: new Map(),
  };
}

function incrementReason(reasons: Map<string, number>, reason: string) {
  reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
}

function qualityBreakdown(counts: MutableQualityBreakdown): LoadQualityBreakdown {
  return {
    read: counts.read,
    accepted: counts.accepted,
    rejected: counts.rejected,
    rejection_reasons: Object.fromEntries(counts.rejectionReasons),
  };
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
