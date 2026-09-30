import {
  describe,
  expect,
  test,
} from 'bun:test';
import type { RemoteDneSourceInfo } from '../src/resolver.ts';
import {
  buildLoadMetadata,
  remoteMetadataMatches,
} from '../src/update-policy.ts';

const remote: RemoteDneSourceInfo = {
  acceptRanges: 'bytes',
  contentLength: '123',
  etag: '"v2"',
  lastModified: 'Sun, 30 Aug 2026 12:00:00 GMT',
  url: 'https://example.test/dne.zip',
};

describe('remote update policy', () => {
  test('requires a rebuild after a schema change even when the source is unchanged', () => {
    const metadata = buildLoadMetadata(remote.url, remote, '1.2.3');
    delete metadata.schema_version;
    expect(remoteMetadataMatches(metadata, remote)).toBe(false);
    expect(remoteMetadataMatches({ ...metadata, schema_version: '1' }, remote)).toBe(false);
  });

  test('requires every available validator to match exactly', () => {
    const metadata = buildLoadMetadata(remote.url, remote, '1.2.3');
    expect(remoteMetadataMatches(metadata, remote)).toBe(true);
    expect(remoteMetadataMatches(metadata, { ...remote, etag: '"v3"' })).toBe(false);
    expect(remoteMetadataMatches(metadata, {
      ...remote,
      lastModified: 'Sun, 30 Aug 2026 12:05:00 GMT',
    })).toBe(false);
    expect(remoteMetadataMatches(metadata, { ...remote, contentLength: '124' })).toBe(false);
  });

  test('does not assume the source is current without validators', () => {
    const metadata = buildLoadMetadata(remote.url, remote, '1.2.3');
    expect(remoteMetadataMatches(metadata, {
      ...remote,
      contentLength: null,
      etag: null,
      lastModified: null,
    })).toBe(false);
  });
});
