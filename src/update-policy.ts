import type { RemoteDneSourceInfo } from './resolver.ts';
import { DATABASE_SCHEMA_VERSION } from './schema.ts';
import type { LoadMetadata } from './types.ts';

/**
 * Determines whether a database uses the current schema and matching ZIP entry identities.
 * @param metadata - Metadata from the last successful import.
 * @param remoteInfo - Current URL and ZIP entry identities for the source.
 * @returns True only for the same remote URL, current schema, and matching entry names, sizes, and CRC32 values.
 */
export function remoteMetadataMatches(
  metadata: LoadMetadata,
  remoteInfo: RemoteDneSourceInfo,
) {
  if (
    metadata.schema_version !== DATABASE_SCHEMA_VERSION
    || metadata.source_kind !== 'remote'
    || metadata.source_url !== remoteInfo.url
    || !remoteInfo.zipEntries?.length
  ) {
    return false;
  }

  return metadata.source_zip_entries === JSON.stringify(remoteInfo.zipEntries);
}

/**
 * Captures source provenance and software/schema versions for a new import.
 * @param source - Original source path or URL supplied to the loader.
 * @param remoteInfo - Remote headers, or null for sources without an HTTP inspection.
 * @param packageVersion - Package version executing the load.
 * @returns String-valued metadata including the current load timestamp in ISO 8601 format.
 */
export function buildLoadMetadata(
  source: string,
  remoteInfo: RemoteDneSourceInfo | null,
  packageVersion: string,
) {
  const metadata: LoadMetadata = {
    loaded_at: new Date().toISOString(),
    package_version: packageVersion,
    schema_version: DATABASE_SCHEMA_VERSION,
    source_input: source,
    source_kind: remoteInfo || looksLikeUrl(source) ? 'remote' : 'local',
  };

  if (remoteInfo) {
    metadata.source_url = remoteInfo.url;
    metadata.source_last_modified = remoteInfo.lastModified ?? '';
    metadata.source_etag = remoteInfo.etag ?? '';
    metadata.source_content_length = remoteInfo.contentLength ?? '';
    if (remoteInfo.zipEntries?.length) {
      metadata.source_zip_entries = JSON.stringify(remoteInfo.zipEntries);
    }
  }

  return metadata;
}

function looksLikeUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
