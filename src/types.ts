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
export const ALL_UFS = Object.keys(stateCodes) as UF[];

const stateNames: Record<UF, string> = {
  RO: 'Rondônia',
  AC: 'Acre',
  AM: 'Amazonas',
  RR: 'Roraima',
  PA: 'Pará',
  AP: 'Amapá',
  TO: 'Tocantins',
  MA: 'Maranhão',
  PI: 'Piauí',
  CE: 'Ceará',
  RN: 'Rio Grande do Norte',
  PB: 'Paraíba',
  PE: 'Pernambuco',
  AL: 'Alagoas',
  SE: 'Sergipe',
  BA: 'Bahia',
  MG: 'Minas Gerais',
  ES: 'Espírito Santo',
  RJ: 'Rio de Janeiro',
  SP: 'São Paulo',
  PR: 'Paraná',
  SC: 'Santa Catarina',
  RS: 'Rio Grande do Sul',
  MS: 'Mato Grosso do Sul',
  MT: 'Mato Grosso',
  GO: 'Goiás',
  DF: 'Distrito Federal',
};
const stateUfsByName = new Map(ALL_UFS.map((uf) => [normalizeStateName(stateNames[uf]), uf]));
const stateUfsByCode = new Map<number, UF>(ALL_UFS.map((uf) => [stateCodes[uf], uf]));

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
 * @returns The canonical supported state abbreviation, or `null` for an unknown value.
 */
export function parseUF(value: string): UF | null {
  const state = value.trim().toUpperCase();
  if (!Object.hasOwn(stateCodes, state)) {
    return null;
  }
  return state as UF;
}

/**
 * Resolves a federative-unit abbreviation to its accented Portuguese name.
 * @param uf - State abbreviation, matched case-insensitively after trimming whitespace.
 * @returns The state name, or `undefined` for an invalid abbreviation.
 */
// oxlint-disable-next-line typescript/no-redundant-type-constituents -- Preserve the requested public UF | string signature.
export function ufToStateName(uf: UF | string): string | undefined {
  const state = parseUF(uf);
  return state === null ? undefined : stateNames[state];
}

/**
 * Resolves a Portuguese state name to its canonical abbreviation.
 * @param name - State name, matched without case or accent distinctions after trimming whitespace.
 * @returns The state abbreviation, or `undefined` for an unknown name.
 */
export function stateNameToUF(name: string): UF | undefined {
  return stateUfsByName.get(normalizeStateName(name));
}

/**
 * Resolves a federative-unit abbreviation to its two-digit IBGE code.
 * @param uf - State abbreviation, matched case-insensitively after trimming whitespace.
 * @returns The numeric state code, or `undefined` for an invalid abbreviation.
 */
// oxlint-disable-next-line typescript/no-redundant-type-constituents -- Preserve the requested public UF | string signature.
export function ufToStateCode(uf: UF | string): number | undefined {
  const state = parseUF(uf);
  return state === null ? undefined : stateCodes[state];
}

/**
 * Resolves a numeric IBGE state code to its canonical abbreviation.
 * @param code - Two-digit IBGE state code.
 * @returns The state abbreviation, or `undefined` for an invalid code.
 */
export function stateCodeToUF(code: number): UF | undefined {
  return stateUfsByCode.get(code);
}

function normalizeStateName(name: string): string {
  return name.trim().normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();
}
