export const BINARY_NAME = 'dne';

export const SQLITE_FILE_NAME = 'dne.db';
export const SQLITE_CEP_TABLE_NAME = 'dne';
export const SQLITE_METADATA_TABLE_NAME = 'edne_metadata';
export const SQLITE_PAGE_SIZE = 32768; // 32KiB
export const SQLITE_CACHE_SIZE = -200000; // ~195 MiB; negative means cache size in KiB not pages
export const SQLITE_INSERT_BATCH_SIZE = 1000;

export const EDNE_DOWNLOAD_URL = 'https://www2.correios.com.br/sistemas/edne/download/eDNE_Basico.zip';

export const HTTP_FETCH_CONCURRENCY = 8;
export const HTTP_FETCH_CHUNK_SIZE = 2 * 1024 * 1024; // 2MB
