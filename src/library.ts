/** Public binary reader, format constants, file helpers, errors, and neighborhood types. */
export * from './binary-db-reader.ts';
/** Address records and provenance returned by the binary reader. */
export type { DneRow, LoadMetadata, UF } from './types.ts';
/** Descriptive locality classification and postal coding status returned by CEP lookups. */
export type { LocalidadeSituacao, LocalidadeTipo } from './schema.ts';
