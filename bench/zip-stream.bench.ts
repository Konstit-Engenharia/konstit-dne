import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLITE_CEP_TABLE_NAME } from '../src/settings.ts';

type WorkerResult = {
  mode: 'buffered' | 'streamed';
  totalSeconds: number;
  resolveSeconds: number;
  loadSeconds: number;
  maxRssMiB: number;
};

type Result = WorkerResult & {
  variant: 'current buffered' | 'streamed cold cache' | 'streamed warm cache';
  rows: number;
};

const zipPath = Bun.argv[2];
const runs = Number(Bun.argv[3] ?? '3');
if (!zipPath || !Number.isInteger(runs) || runs < 1) {
  console.error('Usage: bun run benchmark:zip-stream <eDNE_Basico.zip> [runs]');
  process.exit(1);
}
if (!(await Bun.file(zipPath).exists())) {
  throw new Error(`ZIP file not found: ${zipPath}`);
}

const workDirectory = mkdtempSync(join(tmpdir(), 'edne-zip-stream-benchmark-'));
const nestedZipPath = join(workDirectory, 'eDNE_Basico_inner.zip');
const results: Result[] = [];

try {
  for (let run = 0; run < runs; run++) {
    const bufferedDb = join(workDirectory, `buffered-${run}.db`);
    const coldDb = join(workDirectory, `streamed-cold-${run}.db`);
    const warmDb = join(workDirectory, `streamed-warm-${run}.db`);

    const buffered = runWorker('buffered', zipPath, bufferedDb, nestedZipPath);
    results.push({ ...buffered, variant: 'current buffered', rows: rowCount(bufferedDb) });

    rmSync(nestedZipPath, { force: true });
    const cold = runWorker('streamed', zipPath, coldDb, nestedZipPath);
    results.push({ ...cold, variant: 'streamed cold cache', rows: rowCount(coldDb) });

    const warm = runWorker('streamed', zipPath, warmDb, nestedZipPath);
    results.push({ ...warm, variant: 'streamed warm cache', rows: rowCount(warmDb) });

    if (run === 0) {
      runCommand('bun', ['run', 'scripts/compare-sqlite.ts', bufferedDb, coldDb]);
    }

    rmSync(bufferedDb, { force: true });
    rmSync(coldDb, { force: true });
    rmSync(warmDb, { force: true });
  }

  console.log(
    JSON.stringify(
      {
        source: zipPath,
        runs,
        summary: summarize(results),
        samples: results,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(workDirectory, { recursive: true, force: true });
}

function runWorker(
  mode: WorkerResult['mode'],
  source: string,
  database: string,
  nestedZip: string,
) {
  const result = spawnSync(
    'bun',
    [
      'run',
      'bench/zip-stream-worker.bench.ts',
      mode,
      source,
      database,
      nestedZip,
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || `ZIP stream worker failed with status ${result.status}`);
  }
  return JSON.parse(result.stdout.trim()) as WorkerResult;
}

function runCommand(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} failed with status ${result.status}`);
  }
}

function rowCount(databasePath: string) {
  const db = new Database(databasePath, { readonly: true });
  try {
    return (
      db.query(`SELECT count(*) AS count FROM ${SQLITE_CEP_TABLE_NAME}`).get() as {
        count: number;
      }
    ).count;
  } finally {
    db.close();
  }
}

function summarize(samples: Result[]) {
  const variants = [
    'current buffered',
    'streamed cold cache',
    'streamed warm cache',
  ] as const;

  return Object.fromEntries(
    variants.map((variant) => {
      const matching = samples.filter((sample) => sample.variant === variant);
      return [
        variant,
        {
          medianTotalSeconds: median(matching.map((sample) => sample.totalSeconds)),
          medianResolveSeconds: median(matching.map((sample) => sample.resolveSeconds)),
          medianLoadSeconds: median(matching.map((sample) => sample.loadSeconds)),
          medianMaxRssMiB: median(matching.map((sample) => sample.maxRssMiB)),
          rows: matching[0]?.rows ?? 0,
        },
      ];
    }),
  );
}

function median(values: number[]) {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
  return Number(value.toFixed(3));
}
