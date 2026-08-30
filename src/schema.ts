export type ColumnDefinition = {
  comment?: string;
  name: string;
  type: 'TEXT' | 'INTEGER';
  primaryKey?: boolean;
  notNull?: boolean;
};

export type TableDefinition = {
  name: string;
  originalName: string;
  columns: ColumnDefinition[];
  fileGlob?: string | null;
  unifiedTable?: boolean;
};

export type TableNameMap = Record<string, string>;

const baseTables: TableDefinition[] = [
  {
    name: 'log_localidade',
    originalName: 'log_localidade',
    columns: [],
  },
  {
    name: 'log_bairro',
    originalName: 'log_bairro',
    columns: [],
  },
  {
    name: 'log_cpc',
    originalName: 'log_cpc',
    columns: [],
  },
  {
    name: 'log_logradouro',
    originalName: 'log_logradouro',
    fileGlob: 'LOG_LOGRADOURO_*.TXT',
    columns: [],
  },
  {
    name: 'log_grande_usuario',
    originalName: 'log_grande_usuario',
    columns: [],
  },
  {
    name: 'log_unid_oper',
    originalName: 'log_unid_oper',
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
    ],
  },
];

export function buildSchema(tableNames: TableNameMap = {}): TableDefinition[] {
  return baseTables.map((table) => ({
    ...table,
    name: tableNames[table.originalName] ?? table.name,
    columns: table.columns.map((column) => ({ ...column })),
  }));
}

export function getUnifiedTable(schema: readonly TableDefinition[]): TableDefinition {
  const table = schema.find((candidate) => candidate.unifiedTable);
  if (!table) {
    throw new Error('Unified schema table not found');
  }
  return table;
}

export function getTableFilesGlob(table: TableDefinition): string | null {
  if (table.unifiedTable) {
    return null;
  }
  return table.fileGlob ?? `${table.originalName.toUpperCase()}.TXT`;
}
