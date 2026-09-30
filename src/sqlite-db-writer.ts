import { Database } from 'bun:sqlite';
import { isBairroId } from './bairro.ts';
import { forEachSelectedRow } from './dne-source-parser.ts';
import {
  DneSourceQualityError,
  LoadQualityTracker,
  type LoadQualityCounter,
} from './dne-source-quality.ts';
import type { DneDataSource } from './dne-source.ts';
import {
  DATABASE_SCHEMA_VERSION,
  getSourceFieldIndexes,
  getUnifiedTable,
  LOCALIDADE_TIPO_CODIGOS,
  type LocalidadeSituacaoCodigo,
  type LocalidadeTipoCodigo,
  type TableDefinition,
} from './schema.ts';
import {
  SQLITE_CACHE_SIZE,
  SQLITE_INSERT_BATCH_SIZE,
  SQLITE_METADATA_TABLE_NAME,
  SQLITE_PAGE_SIZE,
} from './settings.ts';
import {
  BatchedUnifiedInsert,
  type UnifiedInsert,
} from './sqlite-db-insert.ts';
import {
  prepareDatabaseForLoad,
  quoteIdent,
} from './sqlite-db-schema.ts';
import type { LoadMetadata } from './types.ts';

/** Receives human-readable progress messages during a database import. */
export type LoadProgress = (message: string) => void;

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

    await forEachSelectedRow(
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

    await forEachSelectedRow(
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
      await forEachSelectedRow(
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

    await forEachSelectedRow(
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

    await forEachSelectedRow(
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
    await forEachSelectedRow(
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

function splitAddress(value: string): [string, string | null] {
  const comma = value.indexOf(',');
  if (comma === -1) {
    return [value.trim(), null];
  }
  return [value.slice(0, comma).trim(), value.slice(comma + 1).trim()];
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
