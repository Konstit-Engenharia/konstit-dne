import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  DneResolver,
  inspectRemoteDneSource,
} from '../src/resolver.ts';
import { buildSchema } from '../src/schema.ts';
import { expectRejects } from './helpers.ts';

describe('remote resolver', () => {
  test('downloads the source for each resolution', async () => {
    const originalFetch = globalThis.fetch;
    const url = `https://example.test/edne-${crypto.randomUUID()}.zip`;
    let downloadCount = 0;

    globalThis.fetch = (async (_input, init) => {
      if (init?.method === 'HEAD') {
        return new Response(null, {
          headers: { 'content-length': '3' },
        });
      }

      downloadCount++;
      return new Response(new Uint8Array([1, 2, 3]));
    }) as typeof fetch;

    try {
      await expectRejects(resolveInvalidRemote(url));
      await expectRejects(resolveInvalidRemote(url));
      expect(downloadCount).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('inspects remote metadata with HEAD', async () => {
    const originalFetch = globalThis.fetch;
    const url = 'https://example.test/head.zip';
    const lastModified = 'Wed, 21 Oct 2015 07:28:00 GMT';
    let requestCount = 0;

    globalThis.fetch = (async (_input, init) => {
      requestCount++;
      expect(init?.method).toBe('HEAD');
      return new Response(null, {
        headers: {
          'accept-ranges': 'bytes',
          'content-length': '123',
          'etag': '"version-1"',
          'last-modified': lastModified,
        },
      });
    }) as typeof fetch;

    try {
      expect(await inspectRemoteDneSource(url)).toEqual({
        url,
        acceptRanges: 'bytes',
        contentLength: '123',
        etag: '"version-1"',
        lastModified,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requestCount).toBe(1);
  });

  test('falls back from HEAD to a one-byte range request', async () => {
    const originalFetch = globalThis.fetch;
    const url = 'https://example.test/head-refused.zip';
    const methods: string[] = [];
    let bodyCancelled = false;

    globalThis.fetch = (async (_input, init) => {
      methods.push(init?.method ?? 'GET');
      if (init?.method === 'HEAD') {
        return new Response(null, { status: 405 });
      }
      expect(new Headers(init?.headers).get('range')).toBe('bytes=0-0');
      expect(new Headers(init?.headers).get('accept-encoding')).toBe('identity');
      const body = new ReadableStream({
        cancel: () => {
          bodyCancelled = true;
        },
      });
      return new Response(body, {
        status: 206,
        headers: {
          'content-length': '1',
          'content-range': 'bytes 0-0/987',
          'etag': '"range-version"',
        },
      });
    }) as typeof fetch;

    try {
      expect(await inspectRemoteDneSource(url)).toEqual({
        url,
        acceptRanges: 'bytes',
        contentLength: '987',
        etag: '"range-version"',
        lastModified: null,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(methods).toEqual(['HEAD', 'GET']);
    expect(bodyCancelled).toBe(true);
  });

  test('retries HEAD after a transient status', async () => {
    const originalFetch = globalThis.fetch;
    let requestCount = 0;

    globalThis.fetch = (async (_input, init) => {
      expect(init?.method).toBe('HEAD');
      requestCount++;
      if (requestCount === 1) {
        return new Response(null, {
          status: 429,
          headers: { 'retry-after': '0' },
        });
      }
      return new Response(null, { headers: { 'content-length': '12' } });
    }) as typeof fetch;

    try {
      const info = await inspectRemoteDneSource('https://example.test/retry-head.zip');
      expect(info.contentLength).toBe('12');
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requestCount).toBe(2);
  });

  test('times out HEAD and its range fallback', async () => {
    const originalFetch = globalThis.fetch;
    let requestCount = 0;

    globalThis.fetch = (async (_input, init) => {
      requestCount++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch;

    try {
      try {
        await inspectRemoteDneSource('https://example.test/timeout.zip', {
          maxRetries: 0,
          timeoutMs: 5,
        });
        throw new Error('Expected inspection to time out');
      } catch (error) {
        expect(error).toHaveProperty('name', 'TimeoutError');
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requestCount).toBe(2);
  });
});

async function resolveInvalidRemote(url: string) {
  const resolver = new DneResolver(url);
  try {
    await resolver.resolve(buildSchema());
  } finally {
    await resolver.cleanup();
  }
}
