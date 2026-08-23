import {
  describe,
  test,
} from 'bun:test';
import { DneResolver } from '../src/resolver.ts';
import { buildSchema } from '../src/schema.ts';
import { expectRejects } from './helpers.ts';

type DeletableBunFile = ReturnType<typeof Bun.file> & {
  delete(): Promise<void>;
};

describe('resolver cleanup coverage', () => {
  test('ignores failure when deleting a completed cache temporary file', async () => {
    const originalFetch = globalThis.fetch;
    const filePrototype = Object.getPrototypeOf(
      Bun.file('/tmp/edne-resolver-coverage'),
    ) as DeletableBunFile;
    const originalDelete = filePrototype.delete;
    const url = `https://example.test/edne-cleanup-${crypto.randomUUID()}.zip`;

    globalThis.fetch = (async (_input, init) => {
      if (init?.method === 'HEAD') {
        return new Response(null, {
          headers: {
            'content-length': '3',
            'last-modified': 'Wed, 01 Jul 2026 12:00:00 GMT',
          },
        });
      }

      return new Response(new Uint8Array([1, 2, 3]));
    }) as typeof fetch;
    filePrototype.delete = function(this: DeletableBunFile) {
      if (this.name?.endsWith('.tmp')) {
        return Promise.reject(new Error('simulated temporary-file cleanup failure'));
      }
      return originalDelete.call(this);
    };

    const resolver = new DneResolver(url);
    try {
      await expectRejects(resolver.resolve(buildSchema()));
    } finally {
      filePrototype.delete = originalDelete;
      globalThis.fetch = originalFetch;
      await resolver.cleanup();
    }
  });
});
