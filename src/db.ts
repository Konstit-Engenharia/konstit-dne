/** Compatibility exports for SQLite access, imports, and schema helpers. */
export type { DneBairro, DneFaixaCep } from './bairro.ts';
export { selectDelimitedFields } from './dne-source-parser.ts';
export {
  DneSourceQualityError,
  type LoadQualityBreakdown,
  type LoadQualityCounts,
  type LoadQualityReport,
  type LoadQualityStage,
} from './dne-source-quality.ts';
export {
  DneDatabaseClosedError,
  DneDatabaseDataError,
  DneDatabaseError,
  type DneDatabaseErrorCode,
  DneDatabaseIOError,
  DneDatabaseQueryError,
  DneDatabaseReader,
  DneDatabaseSchemaError,
  hasTable,
  readDatabaseMetadata,
  sqlitePathFromDatabaseUrl,
} from './sqlite-db-reader.ts';
export {
  cepViewName,
  createCepViewSql,
  createPrettyTableSql,
  createTableSql,
  prepareDatabaseForLoad,
  prepareTableForLoad,
  quoteIdent,
} from './sqlite-db-schema.ts';
export { DneDatabaseWriter, type LoadProgress } from './sqlite-db-writer.ts';
export type { DneRow, LoadMetadata } from './types.ts';
