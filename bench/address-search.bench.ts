import {
  readFileSync,
  statSync,
} from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { addressSearchCases } from './address-search-cases.ts';

const [databasePath = 'data/dne.bin', indexPath = 'data/dne.search.bin', libraryPath, inputMode = 'path',] = Bun.argv.slice(2);
const { DneAddressSearch, DneBinaryDatabaseReader } = await import(
  libraryPath ? pathToFileURL(resolve(libraryPath)).href : '../src/library.ts'
) as typeof import('../src/library.ts');
const before = performance.now();
const database = new DneBinaryDatabaseReader(databasePath);
const databaseOpenMs = performance.now() - before;
Bun.gc(true);
const databaseRss = process.memoryUsage().rss;
const opening = performance.now();
const search = new DneAddressSearch(database, inputMode === 'bytes' ? readFileSync(indexPath) : indexPath);
const searchOpenMs = performance.now() - opening;
Bun.gc(true);
const searchRss = process.memoryUsage().rss;
let sampledMaxRss = searchRss;

try {
  const measurements = addressSearchCases.map(({ query, options }) => {
    for (let warmup = 0; warmup < 3; warmup++) {
      search.searchAddresses(query, options);
    }
    const durations: number[] = [];
    for (let iteration = 0; iteration < 20; iteration++) {
      const start = performance.now();
      search.searchAddresses(query, options);
      durations.push(performance.now() - start);
      sampledMaxRss = Math.max(sampledMaxRss, process.memoryUsage().rss);
    }
    durations.sort((a, b) => a - b);
    const rows = search.searchAddresses(query, options);
    console.error(JSON.stringify({ query, options, p50Ms: durations[9], p95Ms: durations[18] }));
    return {
      query,
      options,
      p50Ms: durations[9],
      p95Ms: durations[18],
      results: rows.length,
      first: rows.slice(0, 3).map(({ cep, logradouro, municipio }) => ({ cep, logradouro, municipio })),
    };
  });
  const finalRss = process.memoryUsage().rss;
  Bun.gc(true);
  const afterGcRss = process.memoryUsage().rss;
  console.log(JSON.stringify(
    {
      runtime: Bun.version,
      cpu: cpus()[0]?.model,
      databaseChecksum: database.checksum(),
      rows: database.rowCount(),
      databaseBytes: statSync(databasePath).size,
      indexBytes: statSync(indexPath).size,
      databaseOpenMs,
      searchOpenMs,
      databaseRss,
      searchRss,
      finalRss,
      afterGcRss,
      sampledMaxRss,
      inputMode,
      warmups: 3,
      iterations: 20,
      measurements,
    },
    null,
    2,
  ));
} finally {
  search.close();
  database.close();
}
