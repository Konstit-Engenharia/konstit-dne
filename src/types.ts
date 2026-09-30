import type {
  LocalidadeSituacao,
  LocalidadeSituacaoCodigo,
  LocalidadeTipo,
  LocalidadeTipoCodigo,
} from './schema.ts';

/** IBGE numeric codes keyed by Brazilian federative-unit abbreviation. */
export const stateCodes = {
  RO: 11,
  AC: 12,
  AM: 13,
  RR: 14,
  PA: 15,
  AP: 16,
  TO: 17,
  MA: 21,
  PI: 22,
  CE: 23,
  RN: 24,
  PB: 25,
  PE: 26,
  AL: 27,
  SE: 28,
  BA: 29,
  MG: 31,
  ES: 32,
  RJ: 33,
  SP: 35,
  PR: 41,
  SC: 42,
  RS: 43,
  MS: 50,
  MT: 51,
  GO: 52,
  DF: 53,
} as const;

/** A Brazilian federative-unit abbreviation supported by the geocoder. */
export type UF = keyof typeof stateCodes;

/** All supported Brazilian federative units in `stateCodes` order. */
export const ALL_UFS = Object.keys(stateCodes).map(parseUF);

/** String-valued provenance and quality metadata stored alongside the imported CEP rows. */
export type LoadMetadata = Record<string, string> & {
  /** Version of the package that performed the import. */
  package_version?: string;
  /** Logical database schema revision used to determine whether a rebuild is required. */
  schema_version?: string;
  /** Source Content-Length header, retained as text. */
  source_content_length?: string;
  /** Source ETag header, including any quotes or weak-validator prefix. */
  source_etag?: string;
  /** Source category, normally `local` or `remote`. */
  source_kind?: string;
  /** Unmodified Last-Modified response header. */
  source_last_modified?: string;
  /** Remote source URL used for validator comparisons. */
  source_url?: string;
};

/** Unified address returned by CEP lookups in current SQLite and binary databases. */
export type DneRow = {
  /** Neighborhood or subordinate locality name, when available. */
  bairro: string | null;
  /** Eight ASCII digits with leading zeros retained and no separator. */
  cep: string;
  /** Additional address information, when available. */
  complemento: string | null;
  /** Descriptive postal coding status of the originating locality, not necessarily the parent municipality. */
  localidade_situacao: LocalidadeSituacao;
  /** Descriptive municipality, district, or village classification of the originating locality. */
  localidade_tipo: LocalidadeTipo;
  /** Street or delivery address; null for a locality-wide CEP. */
  logradouro: string | null;
  /** Municipality name, resolved to the parent for districts and villages. */
  municipio: string;
  /** Seven-digit IBGE municipality code represented as an integer. */
  municipio_cod_ibge: number;
  /** Named recipient, community mailbox, or postal unit, when available. */
  nome: string | null;
  /** Two-letter Brazilian state abbreviation. */
  uf: UF;
};

/** Internal SQLite lookup row before the original DNE codes are converted to descriptive values. */
export type StoredDneRow = Omit<DneRow, 'localidade_situacao' | 'localidade_tipo'> & {
  localidade_situacao: LocalidadeSituacaoCodigo;
  localidade_tipo: LocalidadeTipoCodigo;
};

/**
 * Parses a federative-unit abbreviation.
 *
 * Parsing is case-insensitive and returns the canonical uppercase value.
 *
 * @param value Federative-unit abbreviation, for example `MG`.
 * @returns The canonical supported state abbreviation.
 * @throws {Error} If `value` is not a supported federative unit.
 */
export function parseUF(value: string): UF {
  const state = value.trim().toUpperCase();
  if (!Object.hasOwn(stateCodes, state)) {
    throw new Error(`Unknown UF: ${value}`);
  }
  return state as UF;
}
