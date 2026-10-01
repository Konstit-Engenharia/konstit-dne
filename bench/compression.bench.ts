import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DneRow } from '../src/types.ts';

type Reader = { queryCep(cep: string): DneRow | undefined; close(): void; rowCount(): number; };
type ReaderModule = { DneBinaryDatabaseReader: new(path: string) => Reader; };
const [source, baselineModulePath, baselinePath, candidateModulePath, candidatePath,] = Bun.argv.slice(2);
if (!source || !baselineModulePath || !baselinePath || !candidateModulePath || !candidatePath) {
  throw new Error(
    'Usage: bun bench/compression.bench.ts <source.db> <baseline-reader.ts> <baseline.bin> <candidate-reader.ts> <candidate.bin>',
  );
}
const baselineModule = await import(pathToFileURL(resolve(baselineModulePath)).href) as ReaderModule;
const candidateModule = await import(pathToFileURL(resolve(candidateModulePath)).href) as ReaderModule;
const baseline = new baselineModule.DneBinaryDatabaseReader(baselinePath);
const candidate = new candidateModule.DneBinaryDatabaseReader(candidatePath);
const db = new Database(source, { readonly: true });
const count = (db.query('SELECT count(*) AS count FROM dne').get() as { count: number; }).count;
const hits: string[] = [];
const targetHits = Math.min(100_000, count);
let checked = 0;
try {
  if (baseline.rowCount() !== count || candidate.rowCount() !== count) {
    throw new Error('Row count mismatch');
  }
  for (const row of db.query('SELECT cep FROM dne ORDER BY cep').iterate() as Iterable<{ cep: string; }>) {
    const left = baseline.queryCep(row.cep);
    const right = candidate.queryCep(row.cep);
    if (left === undefined || JSON.stringify(left) !== JSON.stringify(right)) {
      throw new Error(`Mismatch at ${row.cep}`);
    }
    if (checked >= Math.floor(hits.length * count / targetHits) && hits.length < targetHits) {
      hits.push(row.cep);
    }
    checked++;
  }
  const exists = db.query('SELECT 1 FROM dne WHERE cep = ?');
  const misses: string[] = [];
  let state = 0x9e37_79b9;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  while (misses.length < hits.length) {
    const cep = String(random() % 100_000_000).padStart(8, '0');
    if (!exists.get(cep)) {
      misses.push(cep);
    }
  }
  const mixed = hits.slice(0, Math.floor(hits.length / 2)).concat(misses.slice(0, Math.ceil(hits.length / 2)));
  for (const queries of [hits, misses, mixed]) {
    for (let index = queries.length - 1; index > 0; index--) {
      const other = random() % (index + 1);
      const value = queries[index] ?? '';
      queries[index] = queries[other] ?? '';
      queries[other] = value;
    }
  }
  const measurements = [
    measure('hits', hits, hits.length, baseline, candidate),
    measure('mixed', mixed, Math.floor(hits.length / 2), baseline, candidate),
    measure('misses', misses, 0, baseline, candidate),
  ];
  console.log(JSON.stringify(
    {
      runtime: Bun.version,
      verifiedRows: checked,
      baseline: { path: baselinePath, bytes: Bun.file(baselinePath).size, openMs: measureOpen(baselineModule, baselinePath) },
      candidate: { path: candidatePath, bytes: Bun.file(candidatePath).size, openMs: measureOpen(candidateModule, candidatePath) },
      measurements,
    },
    null,
    2,
  ));
} finally {
  db.close();
  baseline.close();
  candidate.close();
}

function run(reader: Reader, queries: string[]) {
  let found = 0;
  for (const cep of queries) {
    if (reader.queryCep(cep)) {
      found++;
    }
  }
  return found;
}

function measure(name: string, queries: string[], expected: number, left: Reader, right: Reader) {
  for (let warmup = 0; warmup < 3; warmup++) {
    run(left, queries);
    run(right, queries);
  }
  const baselineMs: number[] = [];
  const candidateMs: number[] = [];
  for (let round = 0; round < 11; round++) {
    const pair = round % 2 === 0
      ? [[left, baselineMs], [right, candidateMs]] as const
      : [[right, candidateMs], [left, baselineMs]] as const;
    for (const [reader, samples,] of pair) {
      const start = performance.now();
      const found = run(reader, queries);
      samples.push(performance.now() - start);
      if (found !== expected) {
        throw new Error(`${name}: expected ${expected}, found ${found}`);
      }
    }
  }
  return { name, queries: queries.length, expectedFound: expected, baseline: stats(baselineMs), candidate: stats(candidateMs) };
}

function stats(samplesMs: number[]) {
  const sorted = [...samplesMs].sort((left, right) => left - right);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1), samplesMs };
}

function measureOpen(module: ReaderModule, path: string) {
  const samples: number[] = [];
  for (let run = 0; run < 9; run++) {
    const start = performance.now();
    const reader = new module.DneBinaryDatabaseReader(path);
    samples.push(performance.now() - start);
    reader.close();
  }
  return stats(samples);
}
