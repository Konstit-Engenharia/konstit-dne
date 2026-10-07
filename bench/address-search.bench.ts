import {
  readFileSync,
  statSync,
} from 'node:fs';
import { cpus } from 'node:os';
import {
  DneAddressSearch,
  DneBinaryDatabaseReader,
  type AddressSearchOptions,
} from '../src/library.ts';

const [databasePath = 'data/dne.bin', indexPath = 'data/dne.search.bin',] = Bun.argv.slice(2);
const cases: { query: string; options?: AddressSearchOptions; }[] = [
  { query: 'rubens mei' },
  { query: 'rubens mei', options: { uf: 'SP' } },
  { query: 'rubens mei', options: { municipioCodIbge: 3550308 } },
  { query: 'rubens mei 01141-000', options: { uf: 'SP' } },
  { query: 'paulista', options: { uf: 'SP' } },
  { query: 'paulista', options: { municipioCodIbge: 3550308 } },
  { query: '25 de mar', options: { municipioCodIbge: 3550308 } },
  { query: 'joao', options: { uf: 'SP' } },
  { query: 'joao', options: { municipioCodIbge: 3550308 } },
  { query: 'sao', options: { municipioCodIbge: 3550308 } },
  { query: 'sao' },
  { query: 'zzzzzzzzzz' },
  { query: '01141-000' },
];
const before = performance.now();
const database = new DneBinaryDatabaseReader(databasePath);
const databaseOpenMs = performance.now() - before;
Bun.gc(true);
const databaseRss = process.memoryUsage().rss;
const opening = performance.now();
const search = new DneAddressSearch(database, readFileSync(indexPath));
const searchOpenMs = performance.now() - opening;
Bun.gc(true);
const searchRss = process.memoryUsage().rss;

try {
  const measurements = cases.map(({ query, options }) => {
    for (let warmup = 0; warmup < 3; warmup++) {
      search.searchAddresses(query, options);
    }
    const durations: number[] = [];
    for (let iteration = 0; iteration < 20; iteration++) {
      const start = performance.now();
      search.searchAddresses(query, options);
      durations.push(performance.now() - start);
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
      finalRss: process.memoryUsage().rss,
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
