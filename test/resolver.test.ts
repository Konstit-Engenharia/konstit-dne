import {
  describe,
  expect,
  test,
} from 'bun:test';
import { DneResolver } from '../src/resolver.ts';
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
});

async function resolveInvalidRemote(url: string) {
  const resolver = new DneResolver(url);
  try {
    await resolver.resolve(buildSchema());
  } finally {
    await resolver.cleanup();
  }
}
