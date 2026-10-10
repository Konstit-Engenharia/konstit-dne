/// <reference lib="esnext.disposable" preserve="true" />

/** Optional address autocomplete and its database-bound index builder. */
export { buildAddressSearchIndex } from './address-search-index.ts';
export {
  DneAddressSearchPoolClosedError,
  DneAddressSearchQueueFullError,
  DneAddressSearchWorkerError,
} from './address-search-pool-errors.ts';
export { type AddressSearchAsyncOptions, type AddressSearchPoolOptions, DneAddressSearchPool } from './address-search-pool.ts';
export { type AddressSearchOptions, DneAddressSearch } from './address-search.ts';
/** Public binary reader, format constants, file helpers, errors, and neighborhood types. */
export {
  BINARY_DATABASE_HEADER_SIZE,
  BINARY_DATABASE_VERSION,
  type DneBairro,
  DneBinaryDatabaseClosedError,
  DneBinaryDatabaseError,
  type DneBinaryDatabaseErrorCode,
  DneBinaryDatabaseFormatError,
  DneBinaryDatabaseIOError,
  DneBinaryDatabaseReader,
  DneBinaryDatabaseVersionError,
  type DneFaixaCep,
  isBinaryDatabase,
  readBinaryDatabaseMetadata,
} from './binary-db-reader.ts';
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
export { expand as expandAddress } from './expand.ts';
export type { DneRow, LoadMetadata, UF } from './types.ts';
export { ALL_UFS, parseUF, stateCodeToUF, stateNameToUF, ufToStateCode, ufToStateName } from './types.ts';
/** Descriptive locality classification and postal coding status returned by CEP lookups. */
export type { LocalidadeSituacao, LocalidadeTipo } from './schema.ts';
