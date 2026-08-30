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
  sourceFields?: Readonly<Record<string, number>>;
  unifiedTable?: boolean;
};

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
    ],
  },
];

export function buildSchema(tableNames: TableNameMap = {}): TableDefinition[] {
  return baseTables.map((table) => ({
    ...table,
    name: tableNames[table.originalName] ?? table.name,
    columns: table.columns.map((column) => ({ ...column })),
    sourceFields: table.sourceFields ? { ...table.sourceFields } : undefined,
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
