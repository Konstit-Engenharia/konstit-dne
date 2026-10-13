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
  zipEntries: [{ name: 'eDNE_Basico_26092.zip', size: 456, crc32: '4866f6ad' }],
};

describe('remote update policy', () => {
  test('requires a rebuild after a schema change even when the source is unchanged', () => {
    const metadata = buildLoadMetadata(remote.url, remote, '1.2.3');
    delete metadata.schema_version;
    expect(remoteMetadataMatches(metadata, remote)).toBe(false);
    expect(remoteMetadataMatches({ ...metadata, schema_version: '1' }, remote)).toBe(false);
  });

  test('ignores unstable or missing HTTP validators when ZIP identities match', () => {
    const metadata = buildLoadMetadata(remote.url, remote, '1.2.3');
    expect(remoteMetadataMatches(metadata, remote)).toBe(true);
    expect(remoteMetadataMatches(metadata, {
      ...remote,
      etag: '"v3"',
      lastModified: 'Sun, 30 Aug 2026 12:05:00 GMT',
      contentLength: '124',
    })).toBe(true);
    expect(remoteMetadataMatches(metadata, { ...remote, etag: null, lastModified: null, contentLength: null })).toBe(true);
  });

  test.each([
    { name: 'eDNE_Basico_26093.zip', size: 456, crc32: '4866f6ad' },
    { name: 'eDNE_Basico_26092.zip', size: 457, crc32: '4866f6ad' },
    { name: 'eDNE_Basico_26092.zip', size: 456, crc32: '4866f6ae' },
  ])('detects changed entry identity: %j', (entry) => {
    const metadata = buildLoadMetadata(remote.url, remote, '1.2.3');
    expect(remoteMetadataMatches(metadata, { ...remote, zipEntries: [entry] })).toBe(false);
  });

  test.each([{ zipEntries: null }, { zipEntries: undefined }, { zipEntries: [] }])(
    'requires a download when ZIP inspection is unavailable (%j)',
    ({ zipEntries }) => {
      const metadata = buildLoadMetadata(remote.url, remote, '1.2.3');
      expect(remoteMetadataMatches(metadata, { ...remote, zipEntries: zipEntries ? [...zipEntries] : zipEntries })).toBe(false);
    },
  );

  test('requires one new import for databases without ZIP identities', () => {
    const metadata = buildLoadMetadata(remote.url, { ...remote, zipEntries: null }, '1.2.3');
    expect(metadata.source_zip_entries).toBeUndefined();
    expect(remoteMetadataMatches(metadata, remote)).toBe(false);
  });

  test('requires the same remote source', () => {
    const metadata = buildLoadMetadata(remote.url, remote, '1.2.3');
    expect(remoteMetadataMatches({ ...metadata, source_kind: 'local' }, remote)).toBe(false);
    expect(remoteMetadataMatches({ ...metadata, source_url: 'https://example.test/other.zip' }, remote)).toBe(false);
  });

  test('persists ZIP identities alongside diagnostic HTTP headers', () => {
    const metadata = buildLoadMetadata(remote.url, remote, '1.2.3');
    expect(metadata.source_zip_entries).toBe(JSON.stringify(remote.zipEntries));
    expect(metadata.source_etag).toBe(remote.etag ?? '');
    expect(metadata.source_last_modified).toBe(remote.lastModified ?? '');
  });
});
