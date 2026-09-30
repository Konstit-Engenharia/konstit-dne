import type {
  LocalidadeSituacao,
  LocalidadeTipo,
} from './schema.ts';

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
  /** Postal coding status of the originating locality, not necessarily the parent municipality. */
  localidade_situacao: LocalidadeSituacao;
  /** Municipality, district, or village classification of the originating locality. */
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
  uf: string;
};
