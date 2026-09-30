import { Database } from 'bun:sqlite';
import {
  isBairroId,
  type DneBairro,
  type DneFaixaCep,
} from './bairro.ts';
import { cepToU32 } from './cep.ts';
import type { DneDataSource } from './dne-source.ts';
import {
  DATABASE_SCHEMA_VERSION,
  getSourceFieldIndexes,
  getStoredTables,
  getTableFilesGlob,
  getUnifiedTable,
  LOCALIDADE_SITUACOES,
  LOCALIDADE_TIPO_CODIGOS,
  LOCALIDADE_TIPOS,
  type LocalidadeSituacaoCodigo,
  type LocalidadeTipoCodigo,
  type TableDefinition,
} from './schema.ts';
import {
  SQLITE_BAIRRO_FAIXAS_TABLE_NAME,
  SQLITE_BAIRROS_TABLE_NAME,
  SQLITE_CACHE_SIZE,
  SQLITE_CEP_TABLE_NAME,
  SQLITE_INSERT_BATCH_SIZE,
  SQLITE_METADATA_TABLE_NAME,
  SQLITE_PAGE_SIZE,
} from './settings.ts';

import type {
  DneRow,
  LoadMetadata,
  StoredDneRow,
} from './types.ts';

/** Address records and provenance shared by SQLite and binary readers. */
export type { DneRow, LoadMetadata } from './types.ts';

/** Neighborhood records and inclusive CEP intervals shared by both storage formats. */
export type { DneBairro, DneFaixaCep } from './bairro.ts';

type InsertStatement = ReturnType<Database['prepare']>;
/** Receives human-readable progress messages during a database import. */
export type LoadProgress = (message: string) => void;

/** Indicates that source validation rejected rows or produced no usable CEP records. */
export class DneSourceQualityError extends Error {
  /**
   * Creates a source-quality failure that aborts the current load transaction.
   * @param message - Validation summary, including rejection counts or reasons when available.
   */
  constructor(message: string) {
    super(message);
    this.name = 'DneSourceQualityError';
  }
}

/** Read-only SQLite access for CEP lookup, schema inspection, metadata, and bounded SQL queries. */
export class DneDatabaseReader {
  private db: Database;
  private normalizedSchemaReady = false;

  /**
   * Opens an existing SQLite database in read-only mode with a 30-second busy timeout.
   * @param databasePath - Path to the SQLite database.
   * @throws {Error} If SQLite cannot open the database.
   */
  constructor(databasePath: string) {
    this.db = new Database(databasePath, { readonly: true });
    this.db.run('PRAGMA busy_timeout = 30000');
  }

  /** Closes the underlying SQLite connection. Do not perform further operations on this reader. */
  close() {
    this.db.close();
  }

  /**
   * Checks whether a named table exists in the database catalog.
   * @param tableName - Physical table name.
   * @returns True when the catalog contains a table with this name.
   */
  hasTable(tableName: string) {
    return Boolean(this.db.query('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?').get(tableName));
  }

  /**
   * Reads the import metadata table.
   * @returns A new metadata map, or undefined when the metadata table is absent.
   */
  metadata(): LoadMetadata | undefined {
    if (!this.hasTable(SQLITE_METADATA_TABLE_NAME)) {
      return undefined;
    }

    const rows = this.db.query(`SELECT key, value FROM ${quoteIdent(SQLITE_METADATA_TABLE_NAME)}`).all() as {
      key: string;
      value: string;
    }[];
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  /**
   * Looks up a plain or hyphenated CEP in the default unified table.
   * @param cep - Eight ASCII digits or `NNNNN-NNN`, without surrounding whitespace.
   * @returns The matching address, or undefined for invalid input or a missing CEP.
   * @throws {Error} If the database cannot be queried or the matched row lacks the current locality fields.
   */
  queryCep(cep: string): DneRow | undefined {
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
      throw new Error('Database schema lacks locality indicators. Rebuild the database with build --force.');
    }
    const situacao = LOCALIDADE_SITUACOES[row.localidade_situacao];
    const tipo = LOCALIDADE_TIPOS[LOCALIDADE_TIPO_CODIGOS.indexOf(row.localidade_tipo)];
    if (situacao === undefined || tipo === undefined) {
      throw new Error('Database contains invalid locality indicators. Rebuild the database with build --force.');
    }
    return { ...row, localidade_situacao: situacao, localidade_tipo: tipo };
  }

  /**
   * Reads a neighborhood by its original DNE identifier.
   * @param neighborhoodId - Positive `BAI_NU` identifier.
   * @returns The neighborhood, or undefined for an invalid or unknown identifier.
   * @throws {Error} If the database cannot be queried or requires rebuilding.
   */
  queryNeighborhood(neighborhoodId: number): DneBairro | undefined {
    if (!isBairroId(neighborhoodId)) {
      return undefined;
    }
    this.requireCurrentSchema();
    const row = this.db.query(`SELECT * FROM ${quoteIdent(SQLITE_BAIRROS_TABLE_NAME)} WHERE bairro_id = ?`)
      .get(neighborhoodId) as DneBairro | null;
    return row ?? undefined;
  }

  /**
   * Resolves the actual neighborhood attached to a CEP, without treating a district or village as a neighborhood.
   * @param cep - Eight ASCII digits or `NNNNN-NNN`.
   * @returns The neighborhood, or undefined for an invalid, unknown, or neighborhood-free CEP.
   * @throws {Error} If the database cannot be queried or requires rebuilding.
   */
  queryNeighborhoodByCep(cep: string): DneBairro | undefined {
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
  }

  /**
   * Lists a neighborhood's original CEP intervals without merging gaps.
   * @param neighborhoodId - Positive `BAI_NU` identifier.
   * @returns Intervals sorted by their lower and upper bounds; an empty array for invalid, unknown, or rangeless neighborhoods.
   * @throws {Error} If the database cannot be queried or requires rebuilding.
   */
  queryNeighborhoodCepRanges(neighborhoodId: number): DneFaixaCep[] {
    if (!isBairroId(neighborhoodId)) {
      return [];
    }
    this.requireCurrentSchema();
    return this.db.query(`
      SELECT cep_inicial, cep_final FROM ${quoteIdent(SQLITE_BAIRRO_FAIXAS_TABLE_NAME)}
      WHERE bairro_id = ? ORDER BY cep_inicial, cep_final
    `).all(neighborhoodId) as DneFaixaCep[];
  }

  private requireCurrentSchema() {
    if (!this.normalizedSchemaReady) {
      this.normalizedSchemaReady = Boolean(
        this.db.query('SELECT 1 FROM sqlite_master WHERE type = \'view\' AND name = ?')
          .get(cepViewName(SQLITE_CEP_TABLE_NAME)),
      );
    }
    if (!this.normalizedSchemaReady) {
      throw new Error('Database schema lacks normalized neighborhoods. Rebuild the database with build --force.');
    }
  }

  /**
   * Counts all rows in a SQLite table.
   * @param tableName - Existing physical table name.
   * @returns The number of rows reported by SQLite.
   * @throws {Error} If the table cannot be queried.
   */
  rowCount(tableName: string) {
    const row = this.db.query(`SELECT count(*) AS count FROM ${quoteIdent(tableName)}`).get() as { count: number; };
    return row.count;
  }

  /**
   * Reads a table's stored CREATE statement without reconstructing it from the declared schema.
   * @param tableName - Physical table name.
   * @returns The catalog SQL, or undefined when no SQL definition is available.
   */
  tableSchema(tableName: string) {
    const row = this.db.query('SELECT sql FROM sqlite_master WHERE type = \'table\' AND name = ?').get(tableName) as {
      sql: string | null;
    } | null;
    return row?.sql ?? undefined;
  }

  /**
   * Executes caller-supplied SQL on the read-only connection, retaining a bounded result.
   * @param sql - A statement accepted by SQLite; this method does not apply the CLI's statement filter.
   * @param limit - Positive maximum number of rows to retain.
   * @returns Rows plus a flag indicating whether at least one additional row was available.
   * @throws {Error} If statement preparation or execution fails.
   */
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
  bairroId: number | null,
  localidadeNome: string | null,
  municipio: string,
  municipioCodIbge: number,
  uf: string,
  nome: string | null,
  localidadeSituacao: LocalidadeSituacaoCodigo,
  localidadeTipo: LocalidadeTipoCodigo,
];

type Localidade = {
  uf: string;
  nome: string;
  cep: string | null;
  locNuSub: string | null;
  munNu: number | null;
  situacao: LocalidadeSituacaoCodigo;
  tipo: LocalidadeTipoCodigo;
};

type LocalidadeCandidate = Localidade & {
  quality: LoadQualityCounter;
};

type Bairro = {
  id: number;
  uf: string;
  locNu: string;
  nome: string;
  abreviado: string | null;
};

/** Row counts for a source file, import stage, or complete load. */
export type LoadQualityCounts = {
  /** Source rows examined. */
  read: number;
  /** Source rows accepted after validation. */
  accepted: number;
  /** Source rows rejected by validation. */
  rejected: number;
};

/** Validation counts augmented with machine-readable rejection reasons. */
export type LoadQualityBreakdown = LoadQualityCounts & {
  /** Rejected-row counts grouped by reason identifier. */
  rejection_reasons: Record<string, number>;
};

/** Aggregate validation results for a logical DNE source table. */
export type LoadQualityStage = LoadQualityBreakdown & {
  /** Per-file validation results keyed by the source filename. */
  files: Record<string, LoadQualityBreakdown>;
};

/** Quality report persisted only after a load has passed validation. */
export type LoadQualityReport = {
  /** Revision of the quality-report structure, independent of the database schema version. */
  version: 1;
  /** Successful validation marker; failed loads do not persist a report. */
  status: 'passed';
  /** Number of CEP rows written to the unified output. */
  output_rows: number;
  /** Total source-row counts across every stage. */
  totals: LoadQualityCounts;
  /** Validation results keyed by logical DNE source table name. */
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
  private stages: Map<string, MutableQualityStage>;

  constructor() {
    this.stages = new Map();
  }

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
    const params = Array.from({ length: rows.length * 11 }, () => null as UnifiedInsertValue);

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      if (!row) {
        throw new Error(`Missing row at index ${rowIndex}`);
      }
      const offset = rowIndex * 11;
      for (let column = 0; column < row.length; column++) {
        params[offset + column] = row[column] ?? null;
      }
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

    const placeholders = Array.from({ length: rowCount }, () => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    statement = this.db.prepare(`
      INSERT INTO ${quoteIdent(this.tableName)}
        (cep, logradouro, complemento, bairro_id, localidade_nome, municipio, municipio_cod_ibge, uf, nome, localidade_situacao, localidade_tipo)
      VALUES ${placeholders}
    `);
    this.statements.set(rowCount, statement);
    return statement;
  }
}

/** Imports DNE source files into a unified SQLite table with transactional source validation. */
export class DneDatabaseWriter {
  private db: Database;
  private tableByOriginalName: Map<string, TableDefinition>;
  private unifiedTable: TableDefinition;

  /**
   * Opens or creates the SQLite destination for subsequent imports.
   * @param databasePath - Destination path or `:memory:`.
   * @param schema - Source mappings and one unified output table definition.
   * @throws {Error} If the database cannot be opened or the unified table is missing.
   */
  constructor(databasePath: string, private schema: TableDefinition[]) {
    this.db = new Database(databasePath);
    this.tableByOriginalName = new Map(schema.map((table) => [table.originalName, table]));
    this.unifiedTable = getUnifiedTable(schema);
  }

  /** Checkpoints and truncates the WAL, then closes the SQLite connection. */
  close() {
    this.db.run('PRAGMA locking_mode = NORMAL');
    // Disable persistent WAL (needed on macOS)
    // this.db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
    // Checkpoint and truncate the WAL file
    this.db.run('PRAGMA wal_checkpoint(TRUNCATE);');
    this.db.close();
  }

  /**
   * Compacts a completed import before publishing its SQLite file.
   * @throws {Error} If SQLite cannot rewrite the database or an import transaction is active.
   */
  compact() {
    this.db.run('VACUUM');
  }

  /**
   * Replaces the unified table contents and metadata in a single transaction.
   * Schema changes, rejected rows, source errors, and callback failures roll back together.
   * @param source - Complete DNE source with the files required by the configured schema.
   * @param metadata - Caller provenance; generated schema and quality metadata take precedence.
   * @param onProgress - Synchronous callback invoked when each import stage starts.
   * @returns The number of CEP records committed.
   * @throws {DneSourceQualityError} If validation rejects rows or the import produces no records.
   * @throws {Error} If source access, SQLite operations, or a progress callback fails.
   */
  async loadFromSource(source: DneDataSource, metadata: LoadMetadata = {}, onProgress: LoadProgress = () => {}) {
    const cepTable = this.unifiedTable;
    const quality = new LoadQualityTracker();

    this.configureBulkLoad();
    await this.transaction(async () => {
      prepareDatabaseForLoad(this.db, this.schema);
      this.createMetadataTable();
      this.db.run(`DELETE FROM ${quoteIdent(SQLITE_METADATA_TABLE_NAME)}`);

      onProgress('Lendo municípios');
      const localidades = await this.readLocalidades(source, quality);
      onProgress('Lendo bairros');
      const bairros = await this.readBairros(source, localidades, quality);
      this.insertBairros(bairros);
      onProgress('Carregando faixas de CEP dos bairros');
      await this.insertFaixasBairro(source, bairros, quality);
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
          schema_version: DATABASE_SCHEMA_VERSION,
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
      getSourceFieldIndexes(table, ['locNu', 'uf', 'nome', 'cep', 'situacao', 'tipo', 'locNuSub', 'munNu']),
      quality,
      (row, _file, counter) => {
        const [locNu = null, uf = null, nome = null, cep = null, situacao = null, tipoRaw = null, locNuSub = null, munNuRaw = null,] = row;
        const requiredProblem = missingRequiredField([
          ['locNu', locNu],
          ['uf', uf],
          ['nome', nome],
          ['situacao', situacao],
          ['tipo', tipoRaw],
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
        if (situacao !== '0' && situacao !== '1' && situacao !== '2' && situacao !== '3') {
          counter.reject('invalid_localidade_situacao');
          return;
        }
        const tipo = LOCALIDADE_TIPO_CODIGOS.find((value) => value === tipoRaw);
        if (!tipo) {
          counter.reject('invalid_localidade_tipo');
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
          situacao: Number(situacao) as LocalidadeSituacaoCodigo,
          tipo,
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
      getSourceFieldIndexes(table, ['baiNu', 'uf', 'locNu', 'bairro', 'abreviado']),
      quality,
      (row, _file, counter) => {
        const [baiNu = null, uf = null, locNu = null, bairro = null, abreviado = null,] = row;
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
        const id = parseSourceId(baiNu);
        if (id === null || parseSourceId(locNu) === null) {
          counter.reject('invalid_bairro_identifier');
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

        bairros.set(baiNu, { id, uf, locNu, nome: bairro, abreviado });
        counter.accept();
      },
    );

    return bairros;
  }

  private insertBairros(bairros: Map<string, Bairro>) {
    const table = this.originalTable('bairros');
    const insert = this.db.prepare(`
      INSERT INTO ${quoteIdent(table.name)} (bairro_id, localidade_id, uf, nome, nome_abreviado) VALUES (?, ?, ?, ?, ?)
    `);
    try {
      for (const bairro of bairros.values()) {
        insert.run(bairro.id, Number(bairro.locNu), bairro.uf, bairro.nome, bairro.abreviado);
      }
    } finally {
      insert.finalize();
    }
  }

  private async insertFaixasBairro(source: DneDataSource, bairros: Map<string, Bairro>, quality: LoadQualityTracker) {
    const table = this.originalTable('log_faixa_bairro');
    const target = this.originalTable('bairro_faixas');
    const seen = new Set<string>();
    const insert = this.db.prepare(`INSERT INTO ${quoteIdent(target.name)} (bairro_id, cep_inicial, cep_final) VALUES (?, ?, ?)`);
    try {
      await this.forEachSelectedRow(
        table,
        source,
        getSourceFieldIndexes(table, ['baiNu', 'cepInicial', 'cepFinal']),
        quality,
        (row, _file, counter) => {
          const [baiNu = null, cepInicial = null, cepFinal = null,] = row;
          const bairro = baiNu === null ? undefined : bairros.get(baiNu);
          if (!bairro) {
            counter.reject('missing_bairro');
            return;
          }
          if (!isValidCep(cepInicial) || !isValidCep(cepFinal)) {
            counter.reject('invalid_cep_range');
            return;
          }
          if (cepInicial > cepFinal) {
            counter.reject('reversed_cep_range');
            return;
          }
          const key = `${bairro.id}:${cepInicial}:${cepFinal}`;
          if (seen.has(key)) {
            counter.reject('duplicate_cep_range');
            return;
          }
          seen.add(key);
          insert.run(bairro.id, cepInicial, cepFinal);
          counter.accept();
        },
      );
    } finally {
      insert.finalize();
    }
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
          bairro.id,
          null,
          municipality.nome,
          municipality.munNu,
          uf,
          null,
          localidade.situacao,
          localidade.tipo,
        );
        counter.accept();
      },
    );
  }

  private insertLocalidades(insert: UnifiedInsert, localidades: Map<string, Localidade>) {
    for (const localidade of localidades.values()) {
      if (localidade.cep && localidade.locNuSub === null && localidade.munNu !== null) {
        insert.run(
          localidade.cep,
          null,
          null,
          null,
          null,
          localidade.nome,
          localidade.munNu,
          localidade.uf,
          null,
          localidade.situacao,
          localidade.tipo,
        );
      }
    }
  }

  private insertLocalidadesSubordinadas(insert: UnifiedInsert, localidades: Map<string, Localidade>) {
    for (const localidade of localidades.values()) {
      const parent = localidade.locNuSub ? localidades.get(localidade.locNuSub) : undefined;
      if (localidade.cep && parent?.munNu !== null && parent?.munNu !== undefined) {
        insert.run(
          localidade.cep,
          null,
          null,
          null,
          localidade.nome,
          parent.nome,
          parent.munNu,
          localidade.uf,
          null,
          localidade.situacao,
          localidade.tipo,
        );
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
        insert.run(
          cep,
          logradouro,
          complemento,
          null,
          null,
          municipality.nome,
          municipality.munNu,
          uf,
          nome,
          localidade.situacao,
          localidade.tipo,
        );
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
        insert.run(
          cep,
          logradouro,
          complemento,
          bairro.id,
          null,
          municipality.nome,
          municipality.munNu,
          uf,
          nome,
          localidade.situacao,
          localidade.tipo,
        );
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
    // Preserve transactional rollback during validation without writing a disk journal.
    this.db.run('PRAGMA journal_mode = MEMORY');
    this.db.run('PRAGMA foreign_keys = ON');
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

function splitAddress(value: string): [string, string | null] {
  const comma = value.indexOf(',');
  if (comma === -1) {
    return [value.trim(), null];
  }
  return [value.slice(0, comma).trim(), value.slice(comma + 1).trim()];
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

function parseSourceId(value: string): number | null {
  return /^\d{1,8}$/.test(value) && isBairroId(Number(value)) ? Number(value) : null;
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

/**
 * Extracts selected fields from one @-delimited DNE record.
 * @param line - A decoded source record without its line terminator.
 * @param indexes - Unique, ascending zero-based field positions.
 * @returns Trimmed field values in index order; missing or empty values are null.
 */
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

/**
 * Quotes a SQLite identifier, escaping embedded double quotes.
 * @param value - One identifier, not a dotted SQL expression.
 * @returns A double-quoted identifier safe to interpolate into SQL.
 */
export function quoteIdent(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
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
 * @throws {Error} If an existing file cannot be opened or queried as SQLite.
 */
export async function readDatabaseMetadata(databasePath: string): Promise<LoadMetadata | undefined> {
  if (databasePath !== ':memory:' && !(await Bun.file(databasePath).exists())) {
    return undefined;
  }

  const db = new Database(databasePath, { readonly: true });
  try {
    const hasMetadata = db.query('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?').get(SQLITE_METADATA_TABLE_NAME);
    if (!hasMetadata) {
      return undefined;
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

/**
 * Checks for a SQLite table without creating a missing database.
 * @param databasePath - Database file path; `:memory:` reports false.
 * @param tableName - Physical table name to locate.
 * @returns False for a missing database or table.
 * @throws {Error} If an existing file cannot be opened or inspected.
 */
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
