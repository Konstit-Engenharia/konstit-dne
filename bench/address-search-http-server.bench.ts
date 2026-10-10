import {
  DneAddressSearch,
  DneAddressSearchPool,
  DneAddressSearchQueueFullError,
  DneBinaryDatabaseReader,
  parseUF,
} from '../src/library.ts';
import type { HttpServerReady } from './address-search-http-common.ts';

// This process runs only the server. The parent samples its RSS, including all worker threads.
const [databasePath, indexPath, workerCount, queueSize,] = Bun.argv.slice(2) as [string, string, string, string];
const workers = Number(workerCount);
const start = performance.now();
const database = workers === 0 ? new DneBinaryDatabaseReader(databasePath) : undefined;
const search = database
  ? new DneAddressSearch(database, indexPath)
  : await DneAddressSearchPool.open({ databasePath, indexPath, workers, maxQueue: Number(queueSize) });
const openMs = performance.now() - start;

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response('ok');
    }
    const text = url.searchParams.get('q') ?? '';
    const ufText = url.searchParams.get('uf');
    const municipality = url.searchParams.get('municipioCodIbge');
    const limit = Number(url.searchParams.get('limit') ?? 10);
    const uf = ufText === null ? undefined : parseUF(ufText);
    if (
      request.method !== 'GET' || url.pathname !== '/addresses' || text.length > 256
      || !Number.isInteger(limit) || limit < 1 || limit > 50 || (ufText !== null && !uf)
      || (municipality !== null && !/^[1-9]\d{6}$/.test(municipality))
    ) {
      return Response.json({ error: 'Invalid request' }, { status: 400 });
    }
    try {
      // Identical parsing, response serialization, and handler shape for both APIs.
      // No cache, deadline, or cancellation changes the amount of search work.
      const addresses = await search.searchAddresses(text, {
        uf,
        municipioCodIbge: municipality === null ? undefined : Number(municipality),
        limit,
      });
      return Response.json({ addresses });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: error instanceof DneAddressSearchQueueFullError ? 503 : 500 });
    }
  },
});

process.send?.({ url: server.url.href, openMs } satisfies HttpServerReady);
process.once('message', () => {
  void (async () => {
    await server.stop();
    await search.close();
    database?.close();
    process.disconnect?.();
  })();
});
