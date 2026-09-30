/** Public binary reader, format constants, file helpers, errors, and neighborhood types. */
export * from './binary-db-reader.ts';
/** SQLite reader and its typed errors. */
export {
  DneDatabaseClosedError,
  DneDatabaseDataError,
  DneDatabaseError,
  type DneDatabaseErrorCode,
  DneDatabaseIOError,
  DneDatabaseQueryError,
  DneDatabaseReader,
  DneDatabaseSchemaError,
} from './sqlite-db-reader.ts';
/** CEP helpers and address records shared by both readers. */
export { CEP_RANGES, cepToU32, formatCep, normalizeCep, ufForCep } from './cep.ts';
export type { DneRow, LoadMetadata, UF } from './types.ts';
export { parseUF } from './types.ts';
/** Descriptive locality classification and postal coding status returned by CEP lookups. */
export type { LocalidadeSituacao, LocalidadeTipo } from './schema.ts';
