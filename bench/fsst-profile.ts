import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DneRow } from '../src/types.ts';

type Reader = { queryCep(cep: string): DneRow | undefined; close(): void; };
type ReaderModule = { DneBinaryDatabaseReader: new(path: string) => Reader; };
type QueryFixture = { hits: string[]; mixed: string[]; misses: string[]; };
const [modulePath, databasePath, fixturePath, workload = 'hits', passesArgument = '100',] = Bun.argv.slice(2);
if (!modulePath || !databasePath || !fixturePath || !['hits', 'mixed', 'misses'].includes(workload)) {
  throw new Error(
    'Usage: bun --cpu-prof --cpu-prof-md bench/fsst-profile.ts <reader.ts> <database.bin> <queries.json> [hits|mixed|misses] [passes]',
  );
}
const passes = Number(passesArgument);
if (!Number.isInteger(passes) || passes < 1) {
  throw new Error('Passes must be a positive integer');
}
const module = await import(pathToFileURL(resolve(modulePath)).href) as ReaderModule;
const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as QueryFixture;
const queries = fixture[workload as keyof QueryFixture];
const reader = new module.DneBinaryDatabaseReader(databasePath);
try {
  // Preparation, database validation, and these warmups can be excluded from
  // the CPU profile by selecting stacks descended from profileLookups.
  for (let warmup = 0; warmup < 3; warmup++) {
    for (const cep of queries) {
      reader.queryCep(cep);
    }
  }
  const start = performance.now();
  const result = profileLookups(reader, queries, passes);
  const elapsedMs = performance.now() - start;
  const expected = workload === 'hits' ? queries.length * passes : workload === 'mixed' ? queries.length * passes / 2 : 0;
  if (result.found !== expected) {
    throw new Error(`Expected ${expected} hits, got ${result.found}`);
  }
  console.log(
    JSON.stringify(
      {
        runtime: Bun.version,
        modulePath,
        databasePath,
        fixturePath,
        workload,
        passes,
        queries: queries.length * passes,
        elapsedMs,
        ...result,
      },
      null,
      2,
    ),
  );
} finally {
  reader.close();
}

function profileLookups(reader: Reader, queries: string[], passes: number) {
  let found = 0;
  let checksum = 0;
  for (let pass = 0; pass < passes; pass++) {
    for (const cep of queries) {
      const row = reader.queryCep(cep);
      if (row) {
        found++;
        checksum = (checksum + (row.logradouro?.length ?? 0) + (row.complemento?.length ?? 0)) >>> 0;
      }
    }
  }
  return { found, checksum };
}
