import {
  afterAll,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadRemoteFile } from '../src/parallel-download.ts';
import {
  HTTP_FETCH_CHUNK_SIZE,
  HTTP_FETCH_CONCURRENCY,
} from '../src/settings.ts';

const workDir = mkdtempSync(join(tmpdir(), 'edne-parallel-download-test-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('parallel download', () => {
  test('downloads byte ranges with bounded concurrency', async () => {
    const chunkCount = HTTP_FETCH_CONCURRENCY + 2;
    const content = Buffer.alloc(HTTP_FETCH_CHUNK_SIZE * (chunkCount - 1) + 17);
    for (let index = 0; index < content.length; index++) {
      content[index] = index % 251;
    }

    const originalFetch = globalThis.fetch;
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    let rangeRequests = 0;

    globalThis.fetch = (async (_input, init) => {
      const range = new Headers(init?.headers).get('range');
      if (!range) {
        throw new Error('Expected a range request');
      }
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match?.[1] || !match[2]) {
        throw new Error(`Invalid test range: ${range}`);
      }

      const start = Number(match[1]);
      const end = Number(match[2]);
      rangeRequests++;
      activeRequests++;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      await Bun.sleep(5);
      activeRequests--;

      return new Response(content.subarray(start, end + 1), {
        status: 206,
        headers: {
          'content-range': `bytes ${start}-${end}/${content.length}`,
        },
      });
    }) as typeof fetch;

    const path = join(workDir, 'parallel.bin');
    try {
      await downloadRemoteFile('https://example.test/parallel.bin', path, {
        acceptRanges: 'bytes',
        contentLength: String(content.length),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(rangeRequests).toBe(chunkCount);
    expect(maximumActiveRequests).toBe(HTTP_FETCH_CONCURRENCY);
    expect(Buffer.from(await Bun.file(path).arrayBuffer()).equals(content)).toBe(true);
  });

  test('uses one serial request when byte ranges are not supported', async () => {
    const content = Buffer.from('serial response');
    const originalFetch = globalThis.fetch;
    let requestCount = 0;

    globalThis.fetch = (async (_input, init) => {
      requestCount++;
      expect(new Headers(init?.headers).has('range')).toBe(false);
      return new Response(content);
    }) as typeof fetch;

    const path = join(workDir, 'serial.bin');
    try {
      await downloadRemoteFile('https://example.test/serial.bin', path, {
        acceptRanges: null,
        contentLength: String(content.length),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestCount).toBe(1);
    expect(Buffer.from(await Bun.file(path).arrayBuffer()).equals(content)).toBe(true);
  });

  test('falls back to a serial request when a server ignores ranges', async () => {
    const content = Buffer.from('range fallback response');
    const originalFetch = globalThis.fetch;
    let rangeRequests = 0;
    let serialRequests = 0;

    globalThis.fetch = (async (_input, init) => {
      if (new Headers(init?.headers).has('range')) {
        rangeRequests++;
      } else {
        serialRequests++;
      }
      return new Response(content);
    }) as typeof fetch;

    const path = join(workDir, 'ignored-range.bin');
    try {
      await downloadRemoteFile('https://example.test/ignored-range.bin', path, {
        acceptRanges: 'bytes',
        contentLength: String(content.length),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(rangeRequests).toBe(1);
    expect(serialRequests).toBe(1);
    expect(Buffer.from(await Bun.file(path).arrayBuffer()).equals(content)).toBe(true);
  });
});
