/** Executable name used in CLI output. */
export const BINARY_NAME = 'dne';

/** Default local SQLite database filename. */
export const SQLITE_FILE_NAME = 'dne.db';
/** Default physical table name for unified CEP rows. */
export const SQLITE_CEP_TABLE_NAME = 'dne';
/** Table storing neighborhoods under their original DNE identifiers. */
export const SQLITE_BAIRROS_TABLE_NAME = 'bairros';
/** Table storing the distinct CEP intervals assigned to each neighborhood. */
export const SQLITE_BAIRRO_FAIXAS_TABLE_NAME = 'bairro_faixas';
/** Table storing string-valued import provenance and quality metadata. */
export const SQLITE_METADATA_TABLE_NAME = 'edne_metadata';
/** SQLite database page size in bytes for generated files. */
export const SQLITE_PAGE_SIZE = 32768; // 32KiB
/** SQLite cache-size pragma; the negative value specifies kibibytes rather than pages. */
export const SQLITE_CACHE_SIZE = -200000; // ~195 MiB; negative means cache size in KiB not pages
/** Maximum number of CEP rows bound in one batched INSERT statement. */
export const SQLITE_INSERT_BATCH_SIZE = 1000;

/** Default Correios e-DNE source archive URL. */
export const EDNE_DOWNLOAD_URL = 'https://www2.correios.com.br/sistemas/edne/download/eDNE_Basico.zip';

/** Maximum number of simultaneous byte-range download workers. */
export const HTTP_FETCH_CONCURRENCY = 8;
/** Target byte-range size in bytes for parallel downloads. */
export const HTTP_FETCH_CHUNK_SIZE = 2 * 1024 * 1024; // 2MB
/** Default timeout per HTTP attempt in milliseconds. */
export const HTTP_FETCH_TIMEOUT_MS = 30_000;
/** Default retry count after the initial HTTP attempt. */
export const HTTP_FETCH_MAX_RETRIES = 2;
/** Initial exponential-backoff delay in milliseconds. */
export const HTTP_FETCH_RETRY_BASE_DELAY_MS = 100;
/** Maximum exponential-backoff delay in milliseconds. */
export const HTTP_FETCH_RETRY_MAX_DELAY_MS = 1_000;
/** Maximum delay honored from a Retry-After response header, in milliseconds. */
export const HTTP_FETCH_RETRY_AFTER_MAX_MS = 2_000;
