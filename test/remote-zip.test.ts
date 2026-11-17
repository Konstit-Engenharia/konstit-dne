import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectRemoteDneZipSource } from '../src/remote-zip.ts';
import { buildSchema } from '../src/schema.ts';
import {
  createNestedZipFixture,
  zipRangeResponse,
} from './helpers.ts';

const workDir = mkdtempSync(join(tmpdir(), 'edne-remote-zip-test-'));
let archive: Buffer;
let directoryStart: number;
let directorySize: number;

beforeAll(() => {
  archive = readFileSync(createNestedZipFixture(join(workDir, 'fixture'), 20));
  directoryStart = archive.readUInt32LE(archive.length - 6);
  directorySize = archive.readUInt32LE(archive.length - 10);
});

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe('remote ZIP inspection', () => {
  test.each(['bytes=-', 'invalid'])('rejects malformed HTTP range %s', (range) => {
    const request = new Request('http://localhost/dne.zip', { headers: { range } });
    expect(zipRangeResponse(request, archive)?.status).toBe(416);
  });

  test('falls back to metadata when a range response has no body', async () => {
    const result = await inspect(archive, (response) => new Response(null, { status: response.status, headers: response.headers }));
    expect(result.info.zipEntries).toBeNull();
    expect(result.heads).toBe(1);
  });

  test('reads only the trailer and directory and matches the imported nested ZIP', async () => {
    const result = await inspect(archive);
    const inner = readFileSync(join(workDir, 'fixture', 'eDNE_Basico_12345.zip'));
    expect(result.ranges).toEqual(['bytes=-22', `bytes=${directoryStart}-${directoryStart + directorySize - 1}`]);
    expect(result.downloadedBytes).toBe(22 + directorySize);
    expect(result.info.zipEntries).toEqual([{
      name: 'eDNE_Basico_12345.zip',
      size: inner.length,
      crc32: Bun.hash.crc32(inner).toString(16).padStart(8, '0'),
    }]);
    expect(result.heads).toBe(0);
  });

  test('finds the trailer with a maximum-length comment and reuses a directory inside the tail', async () => {
    const commented = Buffer.concat([archive, Buffer.alloc(0xffff, 120)]);
    commented.writeUInt16LE(0xffff, archive.length - 2);
    const result = await inspect(commented);
    expect(result.ranges).toEqual(['bytes=-22', 'bytes=-65557', `bytes=${directoryStart}-${directoryStart + directorySize - 1}`]);
    expect(result.info.zipEntries).toHaveLength(1);
    const shortComment = Buffer.concat([archive, Buffer.from('ZIP comment')]);
    shortComment.writeUInt16LE(11, archive.length - 2);
    const shortResult = await inspect(shortComment);
    expect(shortResult.ranges).toEqual(['bytes=-22', 'bytes=-65557']);
    expect(shortResult.info.zipEntries).toEqual(result.info.zipEntries);
  });

  test('selects and sorts required entries in a direct DNE ZIP', async () => {
    const inner = readFileSync(join(workDir, 'fixture', 'eDNE_Basico_12345.zip'));
    const result = await inspect(inner);
    const names = result.info.zipEntries?.map((entry) => entry.name) ?? [];
    expect(names.length).toBeGreaterThan(1);
    expect(names).toEqual([...names].sort());
    expect(names.every((name) => name.endsWith('.TXT'))).toBe(true);
  });

  test.each(
    [
      ['missing trailer', (bytes: Buffer) => bytes.writeUInt32LE(0, bytes.length - 22)],
      ['multiple disks', (bytes: Buffer) => bytes.writeUInt16LE(1, bytes.length - 18)],
      ['ZIP64 count', (bytes: Buffer) => bytes.writeUInt16LE(0xffff, bytes.length - 12)],
      ['oversized directory', (bytes: Buffer) => bytes.writeUInt32LE(0x1000000, bytes.length - 10)],
      ['invalid directory offset', (bytes: Buffer) => bytes.writeUInt32LE(0xffffffff, bytes.length - 6)],
      ['invalid entry signature', (bytes: Buffer) => bytes.writeUInt32LE(0, directoryStart)],
      ['invalid entry count', (bytes: Buffer) => {
        bytes.writeUInt16LE(2, bytes.length - 14);
        bytes.writeUInt16LE(2, bytes.length - 12);
      }],
      ['encrypted entry', (bytes: Buffer) => bytes.writeUInt16LE(1, directoryStart + 8)],
      ['ZIP64 entry', (bytes: Buffer) => bytes.writeUInt32LE(0xffffffff, directoryStart + 24)],
      ['missing DNE entry', (bytes: Buffer) => bytes.fill(120, directoryStart + 46, directoryStart + 46 + 21)],
    ] as const,
  )('falls back to full-download metadata for %s', async (_label, damage) => {
    const damaged = Buffer.from(archive);
    damage(damaged);
    const result = await inspect(damaged);
    expect(result.info.zipEntries).toBeNull();
    expect(result.info.acceptRanges).toBeNull();
    expect(result.heads).toBe(1);
  });

  test.each(['ignored', 'refused', 'wrong-range', 'changed-size', 'truncated', 'oversized', 'network-error'])(
    'falls back when the server returns %s ranges',
    async (mode) => {
      const result = await inspect(archive, (response, request) => {
        if (mode === 'network-error') {
          throw new Error('Network unavailable');
        }
        if (mode === 'ignored') {
          return new Response(archive);
        }
        if (mode === 'refused') {
          return new Response(null, { status: 416 });
        }
        if (mode === 'wrong-range') {
          response.headers.set('content-range', 'bytes 0-21/100');
        }
        if (mode === 'changed-size' && request.headers.get('range') !== 'bytes=-22') {
          response.headers.set('content-range', `bytes ${directoryStart}-${directoryStart + directorySize - 1}/${archive.length + 1}`);
        }
        if (mode === 'truncated' || mode === 'oversized') {
          const size = Number(response.headers.get('content-length'));
          const headers = new Headers(response.headers);
          headers.delete('content-length');
          return new Response(Buffer.alloc(size + (mode === 'truncated' ? -1 : 1)), { status: 206, headers });
        }
        return response;
      });
      expect(result.info.zipEntries).toBeNull();
      expect(result.info.acceptRanges).toBeNull();
      expect(result.heads).toBe(1);
    },
  );

  test('preserves caller cancellation instead of falling back', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const error = await inspectRemoteDneZipSource('https://example.test/cancelled.zip', buildSchema(), {
      signal: controller.signal,
      maxRetries: 0,
    }).catch((reason: unknown) => reason);
    expect(error).toBe(controller.signal.reason);
  });
});

async function inspect(bytes: Buffer, change?: (response: Response, request: Request) => Response) {
  const originalFetch = globalThis.fetch;
  const ranges: string[] = [];
  let heads = 0;
  let downloadedBytes = 0;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const request = new Request(url, init);
    if (request.method === 'HEAD') {
      heads++;
      return new Response(null, { headers: { 'content-length': String(bytes.length), 'etag': '"stable"' } });
    }
    ranges.push(request.headers.get('range') ?? '');
    expect(request.headers.get('accept-encoding')).toBe('identity');
    const response = zipRangeResponse(request, bytes);
    if (!response) {
      throw new Error('Expected a range request');
    }
    downloadedBytes += Number(response.headers.get('content-length'));
    return change ? change(response, request) : response;
  }) as typeof fetch;
  try {
    const info = await inspectRemoteDneZipSource('https://example.test/dne.zip', buildSchema(), { maxRetries: 0 });
    return { info, ranges, heads, downloadedBytes };
  } finally {
    globalThis.fetch = originalFetch;
  }
}
