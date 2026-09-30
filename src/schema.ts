/** Logical schema revision recorded in load metadata to invalidate outdated imports. */
export const DATABASE_SCHEMA_VERSION = '3';
/** DNE locality codes in the order used by the binary format: municipality, district, village. */
export const LOCALIDADE_TIPOS = ['M', 'D', 'P'] as const;
/** Original `LOC_IN_TIPO_LOC` code: municipality (`M`), district (`D`), or village (`P`). */
export type LocalidadeTipo = (typeof LOCALIDADE_TIPOS)[number];
/** Original `LOC_IN_SIT`: no street coding (0), street coding (1), included district/village (2), or coding in progress (3). */
export type LocalidadeSituacao = 0 | 1 | 2 | 3;

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
    },
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
      { name: 'bairro', type: 'TEXT' },
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
    columns: table.columns.map((column) => ({ ...column })),
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
 * Resolves the source filename pattern for a table.
 * @param table - Source or output table definition.
 * @returns The explicit or derived uppercase TXT pattern, or null for a generated table.
 */
export function getTableFilesGlob(table: TableDefinition): string | null {
  if (table.unifiedTable) {
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
