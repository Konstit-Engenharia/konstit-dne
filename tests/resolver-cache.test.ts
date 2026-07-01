import {
  describe,
  expect,
  test,
} from 'bun:test';
import { DneResolver } from '../src/resolver.ts';
import { buildSchema } from '../src/schema.ts';
import { expectRejects } from './helpers.ts';

describe('resolver cache', () => {
  test('force skips remote download cache', async () => {
    const originalFetch = globalThis.fetch;
    const url = `https://example.test/edne-${Date.now()}.zip`;
    let getCount = 0;

    globalThis.fetch = (async (_input, init) => {
      if (init?.method === 'HEAD') {
        return new Response(null, {
          headers: {
            'content-length': '3',
            'last-modified': 'Wed, 01 Jul 2026 12:00:00 GMT',
          },
        });
      }

      getCount++;
      return new Response(new Uint8Array([1, 2, 3]));
    }) as typeof fetch;

    try {
      await expectRejects(resolveInvalidRemote(url));
      expect(getCount).toBe(1);

      await expectRejects(resolveInvalidRemote(url));
      expect(getCount).toBe(1);

      await expectRejects(resolveInvalidRemote(url, { skipCache: true }));
      expect(getCount).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

async function resolveInvalidRemote(url: string, options: { skipCache?: boolean; } = {}) {
  const resolver = new DneResolver(url, options);
  try {
    await resolver.resolve(buildSchema());
  } finally {
    await resolver.cleanup();
  }
}
