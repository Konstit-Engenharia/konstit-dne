/** Run: DNE_SEARCH_INDEX=./data/dne.bin.search.bin bun examples/address-search-pool.ts 'paulista' */
import {
  DneAddressSearchPool,
  DneAddressSearchPoolClosedError,
  DneAddressSearchQueueFullError,
  DneAddressSearchWorkerError,
  type AddressSearchAsyncOptions,
  type AddressSearchPoolOptions,
} from '../src/library.ts';

const databasePath = process.env['DNE_DATABASE'];
const options: AddressSearchPoolOptions = {
  databasePath,
  indexPath: process.env['DNE_SEARCH_INDEX'] ?? `${databasePath ?? './data/dne.bin'}.search.bin`,
  workers: 2,
  maxQueue: 8,
};
const text = process.argv[2] ?? 'paulista';
let pool: DneAddressSearchPool | undefined;
try {
  // Open once per process and reuse the same pool for concurrent requests.
  pool = await DneAddressSearchPool.open(options);
  const searchOptions: AddressSearchAsyncOptions = { limit: 5, signal: AbortSignal.timeout(5_000) };
  const results = await Promise.all([
    pool.searchAddresses(text, searchOptions),
    pool.searchAddresses('01001-000', searchOptions),
    pool.searchAddresses(text, { uf: 'SP', municipioCodIbge: 3550308, limit: 3 }),
  ]);
  console.log({ results });

  const controller = new AbortController();
  const cancelled = pool.searchAddresses(text, { signal: controller.signal }).catch((error: unknown) => {
    if (error !== controller.signal.reason) {
      throw error;
    }
    console.log('Previous search cancelled');
  });
  controller.abort(new Error('A newer query replaced this search'));
  await cancelled;
  // An aborted calculation may finish in its worker; its result is discarded.

  const pending = pool.searchAddresses(text, { limit: 1 });
  // Stop accepting work and observe both promises while the pool drains.
  const [drained,] = await Promise.all([pending, pool.close()]);
  console.log({ drained });
} catch (error) {
  if (error instanceof DneAddressSearchQueueFullError) {
    console.error('The waiting queue is full; apply backpressure.', error.code);
  } else if (error instanceof DneAddressSearchPoolClosedError) {
    console.error('The pool has closed; do not submit more searches.', error.code);
  } else if (error instanceof DneAddressSearchWorkerError) {
    console.error('Pool initialization or execution failed.', error.code, error.cause);
  } else {
    throw error; // Includes AbortSignal reasons and invalid search options.
  }
  process.exitCode = 1;
} finally {
  await pool?.close(); // Repeated close() calls are safe.
}
