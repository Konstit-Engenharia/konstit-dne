import type { LoadMetadata } from './db.ts';
import type { RemoteDneSourceInfo } from './resolver.ts';

export function remoteMetadataMatches(
  metadata: LoadMetadata,
  remoteInfo: RemoteDneSourceInfo,
) {
  if (
    metadata.source_kind !== 'remote'
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

export function buildLoadMetadata(
  source: string,
  remoteInfo: RemoteDneSourceInfo | null,
  packageVersion: string,
) {
  const metadata: LoadMetadata = {
    loaded_at: new Date().toISOString(),
    package_version: packageVersion,
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
