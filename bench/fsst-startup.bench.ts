import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [readerPath, databasePath, cep = '01001010',] = Bun.argv.slice(2);
if (!readerPath || !databasePath) {
  throw new Error('Usage: bun bench/fsst-startup.bench.ts <reader.ts> <database.bin> [cep]');
}
const { DneBinaryDatabaseReader } = await import(pathToFileURL(resolve(readerPath)).href);
const firstQueries: number[] = [];
for (let run = 0; run < 11; run++) {
  const reader = new DneBinaryDatabaseReader(databasePath);
  try {
    const start = performance.now();
    const result = reader.queryCep(cep);
    firstQueries.push(performance.now() - start);
    if (!result?.logradouro) {
      throw new Error('Choose a CEP with a nonempty logradouro');
    }
  } finally {
    reader.close();
  }
}
const sorted = [...firstQueries].sort((left, right) => left - right);
console.log(JSON.stringify({ readerPath, databasePath, cep, firstQueryMedianMs: sorted[5], firstQueriesMs: firstQueries }, null, 2));
