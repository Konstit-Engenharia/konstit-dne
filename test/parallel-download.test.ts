import {
  afterAll,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  downloadRemoteFile,
  requestWithRetry,
} from '../src/parallel-download.ts';
import {
  HTTP_FETCH_CHUNK_SIZE,
  HTTP_FETCH_CONCURRENCY,
} from '../src/settings.ts';
import { captureRejection } from './assertions.ts';

const noRetryDelay = {
  retryBaseDelayMs: 0,
  retryMaxDelayMs: 0,
};

const workDir = mkdtempSync(join(tmpdir(), 'edne-parallel-download-test-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

async function getRejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected promise to reject');
}

describe('parallel download', () => {
  test('retries transient network errors but preserves non-Error failures', async () => {
    const fetch = spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('network disconnected'))
      .mockResolvedValueOnce(new Response('recovered'));
    try {
      expect(await requestWithRetry('https://example.test', {}, (response) => response.text(), noRetryDelay)).toBe('recovered');
      expect(fetch).toHaveBeenCalledTimes(2);
      fetch.mockRejectedValueOnce('opaque failure');
      expect(await captureRejection(requestWithRetry('https://example.test', {}, (response) => response.text(), noRetryDelay))).toBe(
        'opaque failure',
      );
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      fetch.mockRestore();
    }
  });

  test.each(['Wed, 01 Jan 2020 00:00:00 GMT', 'invalid date'])('handles Retry-After date %p', async (retryAfter) => {
    const fetch = spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('retry', { status: 503, headers: { 'retry-after': retryAfter } }))
      .mockResolvedValueOnce(new Response('ready'));
    try {
      expect(await requestWithRetry('https://example.test', {}, (response) => response.text(), noRetryDelay)).toBe('ready');
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      fetch.mockRestore();
    }
  });

  test('rejects before requesting when cancelled and handles cancellation before a retry delay', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const body = new ReadableStream({
      cancel() {
        controller.abort(reason);
      },
    });
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(body, { status: 503 }));
    try {
      const options = { signal: controller.signal, retryBaseDelayMs: 10 };
      expect(await captureRejection(requestWithRetry('https://example.test', {}, (response) => response.text(), options))).toBe(reason);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await captureRejection(requestWithRetry('https://example.test', {}, (response) => response.text(), options))).toBe(reason);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      fetch.mockRestore();
    }
  });

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

  test('rejects when a range request fails', async () => {
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = (async (_input) => {
      requestCount++;
      return new Response(null, { status: 503 });
    }) as typeof fetch;

    const path = join(workDir, 'failed-range.bin');
    try {
      const error = await getRejection(downloadRemoteFile('https://example.test/failed-range.bin', path, {
        acceptRanges: 'bytes',
        contentLength: '1',
      }, noRetryDelay));
      expect(error.message).toBe('Failed to download https://example.test/failed-range.bin: 503');
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requestCount).toBe(3);
  });

  test('falls back when Content-Range is invalid', async () => {
    const content = Buffer.from('invalid content range fallback');
    const originalFetch = globalThis.fetch;
    let requestCount = 0;

    globalThis.fetch = (async (_input, init) => {
      requestCount++;
      if (new Headers(init?.headers).has('range')) {
        return new Response(content, {
          status: 206,
          headers: { 'content-range': 'invalid' },
        });
      }
      return new Response(content);
    }) as typeof fetch;

    const path = join(workDir, 'invalid-content-range.bin');
    try {
      await downloadRemoteFile('https://example.test/invalid-content-range.bin', path, {
        acceptRanges: 'bytes',
        contentLength: String(content.length),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestCount).toBe(2);
    expect(Buffer.from(await Bun.file(path).arrayBuffer()).equals(content)).toBe(true);
  });

  test('falls back when a range response has the wrong body length', async () => {
    const content = Buffer.from('short range fallback');
    const originalFetch = globalThis.fetch;
    let requestCount = 0;

    globalThis.fetch = (async (_input, init) => {
      requestCount++;
      if (new Headers(init?.headers).has('range')) {
        return new Response(content.subarray(1), {
          status: 206,
          headers: { 'content-range': `bytes 0-${content.length - 1}/${content.length}` },
        });
      }
      return new Response(content);
    }) as typeof fetch;

    const path = join(workDir, 'short-range.bin');
    try {
      await downloadRemoteFile('https://example.test/short-range.bin', path, {
        acceptRanges: 'bytes',
        contentLength: String(content.length),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestCount).toBe(2);
    expect(Buffer.from(await Bun.file(path).arrayBuffer()).equals(content)).toBe(true);
  });

  test('uses a serial request when Content-Length is invalid', async () => {
    const content = Buffer.from('invalid length response');
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (_input, init) => {
      expect(new Headers(init?.headers).has('range')).toBe(false);
      return new Response(content);
    }) as typeof fetch;

    const path = join(workDir, 'invalid-length.bin');
    try {
      await downloadRemoteFile('https://example.test/invalid-length.bin', path, {
        acceptRanges: 'none, BYTES',
        contentLength: 'not-a-length',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(Buffer.from(await Bun.file(path).arrayBuffer()).equals(content)).toBe(true);
  });

  test('rejects when a serial request fails', async () => {
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = (async (_input) => {
      requestCount++;
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const path = join(workDir, 'failed-serial.bin');
    try {
      const error = await getRejection(downloadRemoteFile('https://example.test/failed-serial.bin', path, {
        acceptRanges: null,
        contentLength: null,
      }, noRetryDelay));
      expect(error.message).toBe('Failed to download https://example.test/failed-serial.bin: 404');
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requestCount).toBe(1);
  });

  test('rejects a serial response without a body', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input) => new Response(null)) as typeof fetch;

    const path = join(workDir, 'empty-serial.bin');
    try {
      const error = await getRejection(downloadRemoteFile('https://example.test/empty-serial.bin', path, {
        acceptRanges: null,
        contentLength: null,
      }));
      expect(error.message).toBe('Failed to stream https://example.test/empty-serial.bin: empty response body');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('cancels a serial reader after a stream error', async () => {
    const streamError = new Error('stream failed');
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    let released = false;

    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0]) => ({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            throw streamError;
          },
          cancel: async () => {
            cancelled = true;
            throw new Error('cancel failed');
          },
          releaseLock: () => {
            released = true;
          },
        }),
      },
    })) as unknown as typeof fetch;

    const path = join(workDir, 'stream-error.bin');
    try {
      const error = await getRejection(downloadRemoteFile('https://example.test/stream-error.bin', path, {
        acceptRanges: null,
        contentLength: null,
      }));
      expect(error).toBe(streamError);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(cancelled).toBe(true);
    expect(released).toBe(true);
  });

  test('rejects when a file write makes no progress', async () => {
    const file = await open(join(workDir, 'write-prototype.bin'), 'w');
    const filePrototype = Object.getPrototypeOf(file) as {
      write: typeof file.write;
    };
    const originalWrite = filePrototype.write;
    await file.close();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input) => new Response('content')) as typeof fetch;
    let writeCount = 0;
    filePrototype.write = async function write(buffer: Uint8Array) {
      return { bytesWritten: writeCount++ === 0 ? 1 : 0, buffer };
    } as unknown as typeof file.write;

    const path = join(workDir, 'failed-write.bin');
    try {
      const error = await getRejection(downloadRemoteFile('https://example.test/failed-write.bin', path, {
        acceptRanges: null,
        contentLength: null,
      }));
      expect(error.message).toBe('Failed to write downloaded content');
    } finally {
      filePrototype.write = originalWrite;
      globalThis.fetch = originalFetch;
    }
    expect(writeCount).toBe(2);
  });

  test('retries transient serial failures and replaces partial output', async () => {
    const originalFetch = globalThis.fetch;
    const content = Buffer.from('complete response');
    let requestCount = 0;

    globalThis.fetch = (async (_input) => {
      requestCount++;
      if (requestCount === 1) {
        let readCount = 0;
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          body: {
            getReader: () => ({
              read: async () => {
                if (readCount++ === 0) {
                  return { done: false, value: new Uint8Array([1, 2, 3]) };
                }
                throw new TypeError('connection reset');
              },
              cancel: async () => {},
              releaseLock: () => {},
            }),
          },
        } as unknown as Response;
      }
      return new Response(content);
    }) as typeof fetch;

    const path = join(workDir, 'retry-partial-serial.bin');
    try {
      await downloadRemoteFile('https://example.test/retry-partial.bin', path, {
        acceptRanges: null,
        contentLength: null,
      }, noRetryDelay);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestCount).toBe(2);
    expect(Buffer.from(await Bun.file(path).arrayBuffer()).equals(content)).toBe(true);
  });

  test('limits retries for retryable HTTP statuses', async () => {
    const originalFetch = globalThis.fetch;
    let requestCount = 0;

    globalThis.fetch = (async (_input) => {
      requestCount++;
      return new Response(null, { status: 425 });
    }) as typeof fetch;

    const path = join(workDir, 'limited-retries.bin');
    try {
      const error = await getRejection(downloadRemoteFile('https://example.test/limited-retries.bin', path, {
        acceptRanges: null,
        contentLength: null,
      }, {
        ...noRetryDelay,
        maxRetries: 2,
      }));
      expect(error.message).toBe('Failed to download https://example.test/limited-retries.bin: 425');
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requestCount).toBe(3);
  });

  test('caps Retry-After before retrying', async () => {
    const originalFetch = globalThis.fetch;
    let requestCount = 0;

    globalThis.fetch = (async (_input) => {
      requestCount++;
      if (requestCount === 1) {
        return new Response(null, {
          status: 429,
          headers: { 'retry-after': '60' },
        });
      }
      return new Response('retried');
    }) as typeof fetch;

    const path = join(workDir, 'retry-after.bin');
    const startedAt = performance.now();
    try {
      await downloadRemoteFile('https://example.test/retry-after.bin', path, {
        acceptRanges: null,
        contentLength: null,
      }, {
        maxRetries: 1,
        retryAfterMaxMs: 5,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const elapsedMs = performance.now() - startedAt;
    expect(requestCount).toBe(2);
    expect(elapsedMs).toBeGreaterThanOrEqual(4);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  test('times out a stalled serial response body and retries', async () => {
    const originalFetch = globalThis.fetch;
    let requestCount = 0;

    globalThis.fetch = (async (_input, init) => {
      requestCount++;
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
        },
      });
      return new Response(body);
    }) as typeof fetch;

    const path = join(workDir, 'timeout-serial.bin');
    try {
      const error = await getRejection(downloadRemoteFile('https://example.test/timeout-serial.bin', path, {
        acceptRanges: null,
        contentLength: null,
      }, {
        ...noRetryDelay,
        maxRetries: 1,
        timeoutMs: 5,
      }));
      expect(error.name).toBe('TimeoutError');
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requestCount).toBe(2);
  });

  test('preserves external cancellation during retry backoff', async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    const cancellation = new Error('cancelled by caller');
    let requestCount = 0;

    globalThis.fetch = (async (_input) => {
      requestCount++;
      return new Response(null, {
        status: 503,
        headers: { 'retry-after': '60' },
      });
    }) as typeof fetch;

    const path = join(workDir, 'cancelled-backoff.bin');
    setTimeout(() => controller.abort(cancellation), 5);
    try {
      const error = await getRejection(downloadRemoteFile('https://example.test/cancelled-backoff.bin', path, {
        acceptRanges: null,
        contentLength: null,
      }, {
        retryAfterMaxMs: 1_000,
        signal: controller.signal,
      }));
      expect(error).toBe(cancellation);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requestCount).toBe(1);
  });
});
