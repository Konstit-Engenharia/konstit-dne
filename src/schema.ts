/** Logical schema revision recorded in load metadata to invalidate outdated imports. */
export const DATABASE_SCHEMA_VERSION = '4';
/** DNE locality codes in the order used by the binary format: municipality, district, village. */
export const LOCALIDADE_TIPO_CODIGOS = ['M', 'D', 'P'] as const;
/** Original `LOC_IN_TIPO_LOC` values retained in DNE imports and SQLite storage. */
export type LocalidadeTipoCodigo = (typeof LOCALIDADE_TIPO_CODIGOS)[number];
/** Original `LOC_IN_SIT` values retained in DNE imports and SQLite storage. */
export type LocalidadeSituacaoCodigo = 0 | 1 | 2 | 3;

/** Descriptive locality types in the same order as `LOCALIDADE_TIPO_CODIGOS`. */
export const LOCALIDADE_TIPOS = ['municipio', 'distrito', 'povoado'] as const;
/** Descriptive classification of the originating locality returned by CEP lookups. */
export type LocalidadeTipo = (typeof LOCALIDADE_TIPOS)[number];
/** Descriptive postal coding statuses indexed by the original `LOC_IN_SIT` code. */
export const LOCALIDADE_SITUACOES = [
  'sem_codificacao_por_logradouro',
  'codificada_por_logradouro',
  'inserida_na_codificacao_por_logradouro',
  'em_codificacao_por_logradouro',
] as const;
/** Postal coding status of the originating locality returned by CEP lookups. */
export type LocalidadeSituacao = (typeof LOCALIDADE_SITUACOES)[number];

/** SQLite column declaration used to generate the unified database schema. */
export type ColumnDefinition = {
  /** Trusted SQL expression inserted into a CHECK constraint; not user-supplied SQL. */
  check?: string;
  /** SQL comment describing the stored value. */
  comment?: string;
  /** Physical column name, quoted when generating SQL. */
  name: string;
  /** SQLite storage affinity. */
  type: 'TEXT' | 'INTEGER';
  /** Includes the column in the table's primary key and implies NOT NULL. */
  primaryKey?: boolean;
  /** Rejects SQL NULL values when enabled. */
  notNull?: boolean;
  /** Optional foreign key, using a physical table name and its referenced column. */
  references?: { table: string; column: string; };
};

/** Describes a DNE source file or the generated unified SQLite table. */
export type TableDefinition = {
  /** Physical table name after applying any caller-provided override. */
  name: string;
  /** Stable logical name used to identify the source and apply overrides. */
  originalName: string;
  /** Output columns; source-only definitions may have an empty array. */
  columns: ColumnDefinition[];
  /** Source filename pattern; null disables file matching and omission derives it from `originalName`. */
  fileGlob?: string | null;
  /** Maps logical source fields to zero-based positions in an @-delimited record. */
  sourceFields?: Readonly<Record<string, number>>;
  /** Marks the generated CEP table, which has no corresponding source file. */
  unifiedTable?: boolean;
  /** Stores a table directly in its primary-key B-tree without a separate rowid. */
  withoutRowid?: boolean;
};

/** Maps stable logical table names to caller-selected physical table names. */
export type TableNameMap = Record<string, string>;

const baseTables: TableDefinition[] = [
  {
    name: 'log_localidade',
    originalName: 'log_localidade',
    sourceFields: {
      locNu: 0,
      uf: 1,
      nome: 2,
      cep: 3,
      situacao: 4,
      tipo: 5,
      locNuSub: 6,
      munNu: 8,
    },
    columns: [],
  },
  {
    name: 'log_bairro',
    originalName: 'log_bairro',
    sourceFields: {
      baiNu: 0,
      uf: 1,
      locNu: 2,
      bairro: 3,
      abreviado: 4,
    },
    columns: [],
  },
  {
    name: 'log_faixa_bairro',
    originalName: 'log_faixa_bairro',
    sourceFields: { baiNu: 0, cepInicial: 1, cepFinal: 2 },
    columns: [],
  },
  {
    name: 'log_cpc',
    originalName: 'log_cpc',
    sourceFields: {
      uf: 1,
      locNu: 2,
      nome: 3,
      endereco: 4,
      cep: 5,
    },
    columns: [],
  },
  {
    name: 'log_logradouro',
    originalName: 'log_logradouro',
    fileGlob: 'LOG_LOGRADOURO_*.TXT',
    sourceFields: {
      uf: 1,
      locNu: 2,
      baiNuIni: 3,
      logNo: 5,
      cep: 7,
      tloTx: 8,
      logStaTlo: 9,
    },
    columns: [],
  },
  {
    name: 'log_grande_usuario',
    originalName: 'log_grande_usuario',
    sourceFields: {
      uf: 1,
      locNu: 2,
      baiNu: 3,
      nome: 5,
      endereco: 6,
      cep: 7,
    },
    columns: [],
  },
  {
    name: 'log_unid_oper',
    originalName: 'log_unid_oper',
    sourceFields: {
      uf: 1,
      locNu: 2,
      baiNu: 3,
      nome: 5,
      endereco: 6,
      cep: 7,
    },
    columns: [],
  },
  {
    name: 'bairros',
    originalName: 'bairros',
    fileGlob: null,
    columns: [
      { name: 'bairro_id', type: 'INTEGER', primaryKey: true, check: 'bairro_id > 0' },
      { name: 'localidade_id', type: 'INTEGER', notNull: true, check: 'localidade_id > 0' },
      { name: 'uf', type: 'TEXT', notNull: true },
      { name: 'nome', type: 'TEXT', notNull: true },
      { name: 'nome_abreviado', type: 'TEXT' },
    ],
  },
  {
    name: 'bairro_faixas',
    originalName: 'bairro_faixas',
    fileGlob: null,
    withoutRowid: true,
    columns: [
      { name: 'bairro_id', type: 'INTEGER', primaryKey: true, references: { table: 'bairros', column: 'bairro_id' } },
      {
        name: 'cep_inicial',
        type: 'TEXT',
        primaryKey: true,
        check: 'length(cep_inicial) = 8 AND cep_inicial NOT GLOB \'*[^0-9]*\'',
      },
      {
        name: 'cep_final',
        type: 'TEXT',
        primaryKey: true,
        check: 'length(cep_final) = 8 AND cep_final NOT GLOB \'*[^0-9]*\' AND cep_inicial <= cep_final',
      },
    ],
  },
  {
    name: 'cep_unificado',
    originalName: 'cep_unificado',
    fileGlob: null,
    unifiedTable: true,
    columns: [
      {
        name: 'cep',
        type: 'TEXT',
        primaryKey: true,
        comment: 'Contém somente os oito dígitos do CEP, sem separadores.',
      },
      { name: 'logradouro', type: 'TEXT' },
      { name: 'complemento', type: 'TEXT' },
      { name: 'bairro_id', type: 'INTEGER', references: { table: 'bairros', column: 'bairro_id' } },
      {
        name: 'localidade_nome',
        type: 'TEXT',
        comment: 'Original district or village name for a locality-wide CEP.',
        check: 'localidade_nome IS NULL OR (bairro_id IS NULL AND localidade_tipo IN (\'D\', \'P\'))',
      },
      { name: 'municipio', type: 'TEXT', notNull: true },
      { name: 'municipio_cod_ibge', type: 'INTEGER', notNull: true },
      { name: 'uf', type: 'TEXT', notNull: true },
      { name: 'nome', type: 'TEXT' },
      { name: 'localidade_situacao', type: 'INTEGER', notNull: true, check: 'localidade_situacao IN (0, 1, 2, 3)' },
      { name: 'localidade_tipo', type: 'TEXT', notNull: true, check: 'localidade_tipo IN (\'M\', \'D\', \'P\')' },
    ],
  },
];

/**
 * Creates independently mutable source and output schema definitions.
 * @param tableNames - Optional physical-name overrides keyed by the original table name.
 * @returns New table, column, and source-field objects for this invocation.
 */
export function buildSchema(tableNames: TableNameMap = {}): TableDefinition[] {
  return baseTables.map((table) => ({
    ...table,
    name: tableNames[table.originalName] ?? table.name,
    columns: table.columns.map((column) => ({
      ...column,
      ...(column.references
        ? { references: { ...column.references, table: tableNames[column.references.table] ?? column.references.table } }
        : {}),
    })),
    sourceFields: table.sourceFields ? { ...table.sourceFields } : undefined,
  }));
}

/**
 * Retrieves the generated CEP table from a schema.
 * @param schema - Source and output table definitions.
 * @returns The first definition marked as the unified table, without copying it.
 * @throws {Error} If the schema has no unified table.
 */
export function getUnifiedTable(schema: readonly TableDefinition[]): TableDefinition {
  const table = schema.find((candidate) => candidate.unifiedTable);
  if (!table) {
    throw new Error('Unified schema table not found');
  }
  return table;
}

/**
 * Lists persisted tables in parent-before-child creation and insertion order.
 * @param schema - Source and output table definitions returned by `buildSchema`.
 * @returns Definitions with output columns; source-only definitions are excluded.
 */
export function getStoredTables(schema: readonly TableDefinition[]): TableDefinition[] {
  return schema.filter((table) => table.columns.length > 0);
}

/**
 * Resolves the source filename pattern for a table.
 * @param table - Source or output table definition.
 * @returns The explicit or derived uppercase TXT pattern, or null for a generated table.
 */
export function getTableFilesGlob(table: TableDefinition): string | null {
  if (table.unifiedTable || table.fileGlob === null) {
    return null;
  }
  return table.fileGlob ?? `${table.originalName.toUpperCase()}.TXT`;
}

/**
 * Resolves logical source fields to their positions in a delimited record.
 * @param table - Definition containing a source-field mapping.
 * @param fields - Field names in the desired output order.
 * @returns Zero-based indexes in the same order as `fields`.
 * @throws {Error} If the mapping or any requested field is missing.
 */
export function getSourceFieldIndexes(table: TableDefinition, fields: readonly string[]): number[] {
  if (!table.sourceFields) {
    throw new Error(`Source fields for table '${table.originalName}' not found`);
  }

  return fields.map((field) => {
    const index = table.sourceFields?.[field];
    if (index === undefined) {
      throw new Error(`Source field '${field}' for table '${table.originalName}' not found`);
    }
    return index;
  });
}
