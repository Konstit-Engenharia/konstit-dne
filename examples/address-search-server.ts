/**
 * Run from the repository root after generating the search index:
 *   bun run build:search-index data/dne.bin data/dne.bin.search.bin
 *   bun examples/address-search-server.ts
 * See examples/README.md for configuration, curl commands, and deployment notes.
 * In an application consuming the published package, import from '@konstit/dne'.
 */
import {
  DneAddressSearchPool,
  DneAddressSearchPoolClosedError,
  DneAddressSearchQueueFullError,
  DneAddressSearchWorkerError,
  parseUF,
} from '../src/library.ts';

const databasePath = process.env['DNE_DATABASE'] ?? './data/dne.bin';
const port = Number(process.env['PORT'] ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new RangeError('PORT must be an integer between 0 and 65535');
}

// Load once, before accepting HTTP traffic. Never open a pool per request.
const search = await DneAddressSearchPool.open({
  databasePath,
  indexPath: process.env['DNE_SEARCH_INDEX'] ?? `${databasePath}.search.bin`,
  workers: Number(process.env['DNE_WORKERS'] ?? 1),
  maxQueue: Number(process.env['DNE_MAX_QUEUE'] ?? 64),
});

// Keep response deadlines separate from computation: aborting a running query discards
// its result but does not interrupt the synchronous calculation inside its worker.
const searchTimeoutMs = 1_000;
let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    hostname: process.env['HOST'] ?? '127.0.0.1',
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== '/addresses') {
        return Response.json({ error: 'Not found' }, { status: 404 });
      }
      if (request.method !== 'GET') {
        return Response.json({ error: 'Use GET' }, { status: 405, headers: { Allow: 'GET' } });
      }

      const text = (url.searchParams.get('q') ?? '').trim();
      const ufText = url.searchParams.get('uf');
      const uf = ufText === null ? undefined : parseUF(ufText);
      const municipalityText = url.searchParams.get('municipioCodIbge');
      const limitText = url.searchParams.get('limit') ?? '10';
      const limit = Number(limitText);
      if (text.length < 3 || text.length > 256) {
        return Response.json({ error: 'q must contain 3 to 256 characters' }, { status: 400 });
      }
      if (ufText !== null && uf === undefined) {
        return Response.json({ error: 'Invalid uf' }, { status: 400 });
      }
      if (municipalityText !== null && (!/^[1-9]\d{6}$/.test(municipalityText))) {
        return Response.json({ error: 'municipioCodIbge must be a seven-digit IBGE code' }, { status: 400 });
      }
      if (!/^\d+$/.test(limitText) || limit < 1 || limit > 50) {
        return Response.json({ error: 'limit must be an integer between 1 and 50' }, { status: 400 });
      }

      const timeout = AbortSignal.timeout(searchTimeoutMs);
      const signal = AbortSignal.any([request.signal, timeout]);
      try {
        const addresses = await search.searchAddresses(text, {
          uf,
          municipioCodIbge: municipalityText === null ? undefined : Number(municipalityText),
          limit,
          signal,
        });
        return Response.json({ addresses });
      } catch (error) {
        if (signal.aborted) {
          // 499 is a conventional, nonstandard status for a disconnected client.
          return Response.json({ error: timeout.aborted ? 'Search timed out' : 'Request cancelled' }, {
            status: timeout.aborted ? 504 : 499,
          });
        }
        if (error instanceof DneAddressSearchQueueFullError) {
          return Response.json({ error: 'Search is busy; retry shortly' }, { status: 503, headers: { 'Retry-After': '1' } });
        }
        if (error instanceof DneAddressSearchPoolClosedError || error instanceof DneAddressSearchWorkerError) {
          console.error('Search pool unavailable', error);
          return Response.json({ error: 'Search unavailable' }, { status: 503 });
        }
        console.error('Address search failed', error);
        return Response.json({ error: 'Internal server error' }, { status: 500 });
      }
    },
  });
} catch (error) {
  // A port conflict must not leave an already initialized pool keeping the process alive.
  await search.close();
  throw error;
}

console.log(`Address search listening on ${server.url.href}`);

let stopping: Promise<void> | undefined;
function shutdown(): void {
  if (stopping) {
    return;
  }
  stopping = (async () => {
    // Stop accepting connections and finish existing requests before draining the pool.
    await server.stop();
    await search.close();
  })().catch((error: unknown) => {
    console.error('Unable to stop address search', error);
    process.exitCode = 1;
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
