import type { Database } from 'bun:sqlite';
import type {
  LocalidadeSituacaoCodigo,
  LocalidadeTipoCodigo,
} from './schema.ts';
import { quoteIdent } from './sqlite-db-schema.ts';

type InsertStatement = ReturnType<Database['prepare']>;

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

export type UnifiedInsert = {
  run(...values: UnifiedInsertRow): void;
  flush(): void;
  finalize(): void;
};

/** Reuses prepared statements for batches of normalized address rows. */
export class BatchedUnifiedInsert implements UnifiedInsert {
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
