import type { LoadMetadata } from './db.ts';
import type { RemoteDneSourceInfo } from './resolver.ts';
import { DATABASE_SCHEMA_VERSION } from './schema.ts';

/**
 * Determines whether a database uses the current schema and matches every available remote validator.
 * @param metadata - Metadata from the last successful import.
 * @param remoteInfo - Current URL and HTTP validators for the source.
 * @returns True only for the same remote URL, current schema, and at least one matching validator with no mismatches.
 */
export function remoteMetadataMatches(
  metadata: LoadMetadata,
  remoteInfo: RemoteDneSourceInfo,
) {
  if (
    metadata.schema_version !== DATABASE_SCHEMA_VERSION
    || metadata.source_kind !== 'remote'
    || metadata.source_url !== remoteInfo.url
  ) {
    return false;
  }

  const validators = [
    validatorMatches(metadata.source_etag, remoteInfo.etag),
    validatorMatches(metadata.source_last_modified, remoteInfo.lastModified),
    validatorMatches(metadata.source_content_length, remoteInfo.contentLength),
  ].filter((value) => value !== null);

  return validators.length > 0 && validators.every(Boolean);
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
  }

  return metadata;
}

function validatorMatches(previous: string | undefined, current: string | null) {
  if (!current) {
    return null;
  }
  return previous === current;
}

function looksLikeUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
