import { heapStats } from 'bun:jsc';
import { Database } from 'bun:sqlite';
import { stat } from 'node:fs/promises';
import { openReadyDatabase } from '../src/database-service.ts';

const databasePath = Bun.argv[2];
const queryCount = Number(Bun.argv[3] ?? '100000');
const querySource = Bun.argv[4];
if (!databasePath || !Number.isSafeInteger(queryCount) || queryCount < 1) {
  console.error('Usage: bun run bench/binary-lookup.bench.ts <database> [query-count] [query-source.db]');
  process.exit(1);
}

const workload = querySource
  ? createMixedWorkload(querySource, queryCount)
  : {
    expectedFound: null,
    kind: 'legacy-range',
    queries: Array.from(
      { length: queryCount },
      (_, index) => String(30_000_001 + (index % 100_000)).padStart(8, '0'),
    ),
  };
// Exclude unreachable allocations from workload preparation from the baseline.
Bun.gc(true);
const memoryBeforeOpen = readMemory();
const reader = await openReadyDatabase(databasePath);
const memoryAfterOpen = readMemory();
let memoryAfterFirstBatch: ReturnType<typeof readMemory> | undefined;
let memoryAfterFirstBatchGc: ReturnType<typeof readMemory> | undefined;
for (let warmup = 0; warmup < 2; warmup++) {
  runQueries(reader, workload.queries);
  if (warmup === 0) {
    // Capture exactly queryCount lookups, before the remaining warmup and timed batches.
    memoryAfterFirstBatch = readMemory();
    Bun.gc(true);
    memoryAfterFirstBatchGc = readMemory();
  }
}

const samples: number[] = [];
let found = 0;
for (let run = 0; run < 9; run++) {
  const started = performance.now();
  found = runQueries(reader, workload.queries);
  samples.push(performance.now() - started);
  if (workload.expectedFound === null ? found === 0 : found !== workload.expectedFound) {
    throw new Error(`Benchmark found an unexpected number of rows: ${found}`);
  }
}
const memoryAfterMeasurements = readMemory();
reader.close();

samples.sort((left, right) => left - right);
const mean = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
const standardDeviation = Math.sqrt(
  samples.reduce((sum, sample) => sum + ((sample - mean) ** 2), 0) / samples.length,
);
console.log(JSON.stringify({
  coefficientOfVariation: standardDeviation / mean,
  database: databasePath,
  databaseBytes: (await stat(databasePath)).size,
  found,
  measuredBatches: samples.length,
  medianMs: samples[4],
  memoryBytes: {
    beforeOpen: memoryBeforeOpen,
    afterOpen: memoryAfterOpen,
    afterFirstBatch: memoryAfterFirstBatch,
    afterFirstBatchGc: memoryAfterFirstBatchGc,
    afterMeasurements: memoryAfterMeasurements,
  },
  p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
  queryCount,
  samplesMs: samples,
  warmupBatches: 2,
  workload: workload.kind,
}));

function readMemory() {
  const memory = process.memoryUsage();
  const { heapSize, extraMemorySize } = heapStats();
  // JavaScriptCore accounts for live cells at the last GC; external strings and buffers are excluded here.
  return { ...memory, heapObjectBytes: heapSize - extraMemorySize };
}

function runQueries(reader: { queryCep(cep: string): unknown; }, queries: string[]) {
  let found = 0;
  for (const cep of queries) {
    if (reader.queryCep(cep)) {
      found++;
    }
  }
  return found;
}

function createMixedWorkload(sourcePath: string, count: number) {
  const db = new Database(sourcePath, { readonly: true });
  try {
    const hitCount = Math.floor(count / 2);
    const row = db.query('SELECT count(*) AS count FROM dne').get() as { count: number; };
    if (hitCount > row.count) {
      throw new Error(`Query source has only ${row.count} rows for ${hitCount} requested hits`);
    }

    const hits: string[] = [];
    if (hitCount) {
      const step = row.count / hitCount;
      let target = 0;
      let index = 0;
      for (const value of db.query('SELECT cep FROM dne ORDER BY cep').iterate() as Iterable<{ cep: string; }>) {
        if (index >= Math.floor(target * step)) {
          hits.push(value.cep);
          target++;
          if (target === hitCount) {
            break;
          }
        }
        index++;
      }
    }

    const missingCount = count - hitCount;
    const misses: string[] = [];
    const exists = db.query('SELECT 1 FROM dne WHERE cep = ?');
    let state = 0x9e37_79b9;
    while (misses.length < missingCount) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const candidate = String((state >>> 0) % 100_000_000).padStart(8, '0');
      if (!exists.get(candidate)) {
        misses.push(candidate);
      }
    }

    const queries: string[] = [];
    for (let index = 0; index < Math.max(hits.length, misses.length); index++) {
      const hit = hits[index];
      if (hit !== undefined) {
        queries.push(hit);
      }
      const miss = misses[index];
      if (miss !== undefined) {
        queries.push(miss);
      }
    }
    return { expectedFound: hitCount, kind: '50%-hit-50%-miss', queries };
  } finally {
    db.close();
  }
}
