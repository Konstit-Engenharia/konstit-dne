import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import {
  cpus,
  release,
  tmpdir,
  totalmem,
} from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import {
  DneAddressSearch,
  DneBinaryDatabaseReader,
} from '../src/library.ts';
import { addressSearchCases } from './address-search-cases.ts';
import {
  percentile,
  type HttpBenchmarkCase,
  type HttpLoadResult,
  type HttpServerReady,
} from './address-search-http-common.ts';

const [
  databaseArgument = 'data/dne.bin',
  indexArgument = 'data/dne.search.bin',
  outputArgument = 'docs/address-search-http-results.json',
] = Bun.argv.slice(2);
const databasePath = resolve(databaseArgument);
const indexPath = resolve(indexArgument);
const outputPath = resolve(outputArgument);
const rounds = positiveInteger(process.env['DNE_BENCH_ROUNDS'] ?? '7');
const durationMs = positiveInteger(process.env['DNE_BENCH_DURATION_MS'] ?? '3000');
const warmupMs = positiveInteger(process.env['DNE_BENCH_WARMUP_MS'] ?? '500');
const concurrencies = (process.env['DNE_BENCH_CONCURRENCY'] ?? '1,8,32').split(',').map(positiveInteger);
const modes = [0, 1, 2, 4];
const maxQueue = 64;
if (Math.max(...concurrencies) > maxQueue + 1) {
  throw new RangeError('Use concurrency <= 65 to compare completed work without deliberate queue overload');
}
const directory = mkdtempSync(join(tmpdir(), 'dne-http-bench-'));
const casesPath = join(directory, 'cases.json');
const database = new DneBinaryDatabaseReader(databasePath);
const search = new DneAddressSearch(database, indexPath);
const cases: HttpBenchmarkCase[] = addressSearchCases.map(({ query, options }) => {
  const params = new URLSearchParams({ q: query, limit: '10' });
  if (options?.uf) {
    params.set('uf', options.uf);
  }
  if (options?.municipioCodIbge) {
    params.set('municipioCodIbge', String(options.municipioCodIbge));
  }
  return {
    query,
    path: `/addresses?${params.toString()}`,
    expectedBody: JSON.stringify({ addresses: search.searchAddresses(query, options) }),
  };
});
const metadata = {
  generatedAt: new Date().toISOString(),
  runtime: Bun.version,
  platform: process.platform,
  osRelease: release(),
  arch: process.arch,
  cpu: cpus()[0]?.model,
  logicalCpus: cpus().length,
  physicalMemoryBytes: totalmem(),
  databaseChecksum: database.checksum(),
  rowCount: database.rowCount(),
  databaseBytes: statSync(databasePath).size,
  indexBytes: statSync(indexPath).size,
  indexSha256: createHash('sha256').update(readFileSync(indexPath)).digest('hex'),
  revision: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(),
  sourceSha256: Object.fromEntries([
    'src/address-search.ts',
    'src/address-search-pool.ts',
    'src/address-search-worker.ts',
    'src/address-search-worker-runtime.ts',
    'src/address-search-rank.ts',
    'src/address-search-index.ts',
    'src/address-search-text.ts',
    'src/binary-db-reader.ts',
    'src/shared-file.ts',
    'bench/address-search-http.bench.ts',
    'bench/address-search-http-server.bench.ts',
    'bench/address-search-http-client.bench.ts',
    'bench/address-search-http-common.ts',
  ].map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
};
search.close();
database.close();
Bun.gc(true);
await Bun.write(casesPath, JSON.stringify(cases));

type Measurement = HttpLoadResult & {
  round: number;
  workers: number;
  concurrency: number;
  openMs: number;
  rss: {
    afterOpenBytes: number;
    afterWarmupBytes: number;
    medianBytes: number;
    sampledMaxBytes: number;
    samples: number;
    lifetimeMaxBytes?: number;
  };
};
const measurements: Measurement[] = [];

try {
  for (let round = 0; round < rounds; round++) {
    // Rotate both dimensions deterministically to spread machine drift across configurations.
    for (let ci = 0; ci < concurrencies.length; ci++) {
      const concurrency = concurrencies[(ci + round) % concurrencies.length] as number;
      for (let mi = 0; mi < modes.length; mi++) {
        const workers = modes[(mi + round + ci) % modes.length] as number;
        const result = await measure(workers, concurrency, round + 1);
        measurements.push(result);
        await save();
        console.error(JSON.stringify({
          round: round + 1,
          mode: workers === 0 ? 'sync' : `pool-${workers}`,
          concurrency,
          rps: Math.round(result.requestsPerSecond),
          p95Ms: Number(result.latency.p95Ms.toFixed(2)),
          rssMB: Number((result.rss.sampledMaxBytes / 1e6).toFixed(1)),
          failures: result.failures,
        }));
        if (result.failures) {
          throw new Error(`Measured requests failed: ${result.firstFailure}`);
        }
      }
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log(outputPath);

function positiveInteger(text: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`Expected a positive integer, received ${text}`);
  }
  return value;
}

async function rss(pid: number): Promise<number> {
  const child = Bun.spawn(['ps', '-o', 'rss=', '-p', String(pid)], { stdout: 'pipe', stderr: 'pipe' });
  const [output, code,] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  const bytes = Number(output.trim()) * 1024;
  if (code !== 0 || !Number.isFinite(bytes) || bytes <= 0) {
    throw new Error(`Unable to sample RSS for PID ${pid}`);
  }
  return bytes;
}

async function measure(workers: number, concurrency: number, round: number): Promise<Measurement> {
  const ready = Promise.withResolvers<HttpServerReady>();
  const server = Bun.spawn([
    process.execPath,
    '--log-level=error',
    resolve('bench/address-search-http-server.bench.ts'),
    databasePath,
    indexPath,
    String(workers),
    String(maxQueue),
  ], {
    env: { ...process.env, BUN_CONFIG_VERBOSE_FETCH: 'false' },
    stdout: 'ignore',
    stderr: 'pipe',
    timeout: 60_000,
    ipc(message: HttpServerReady) {
      ready.resolve(message);
    },
    onExit(_child, code) {
      ready.reject(new Error(`Server exited before readiness: ${code}`));
    },
  });
  const serverErrors = new Response(server.stderr).text();
  let load: ReturnType<typeof Bun.spawn> | undefined;
  let finished = false;
  let samplesPromise: Promise<void> | undefined;
  const samples: number[] = [];
  try {
    const info = await ready.promise;
    const afterOpenBytes = await rss(server.pid);
    const client = Bun.spawn([
      process.execPath,
      '--log-level=error',
      resolve('bench/address-search-http-client.bench.ts'),
      info.url,
      casesPath,
      String(concurrency),
      String(durationMs),
      String(warmupMs),
    ], {
      env: { ...process.env, BUN_CONFIG_VERBOSE_FETCH: 'false' },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
      ipc(_message, child) {
        samplesPromise = (async () => {
          samples.push(await rss(server.pid));
          child.send('go');
          while (!finished) {
            await Bun.sleep(100);
            if (!finished) {
              samples.push(await rss(server.pid));
            }
          }
        })();
      },
    });
    load = client;
    const [output, errors, code,] = await Promise.all([
      new Response(client.stdout).text(),
      new Response(client.stderr).text(),
      client.exited,
    ]);
    finished = true;
    await samplesPromise;
    if (code !== 0) {
      throw new Error(`Load generator failed (${code}): ${errors}`);
    }
    const result = JSON.parse(output) as HttpLoadResult;
    server.send('stop');
    const serverCode = await server.exited;
    if (serverCode !== 0) {
      throw new Error(`Server failed (${serverCode}): ${await serverErrors}`);
    }
    const afterWarmupBytes = samples[0] as number;
    const sorted = [...samples].sort((a, b) => a - b);
    return {
      round,
      workers,
      concurrency,
      ...result,
      openMs: info.openMs,
      rss: {
        afterOpenBytes,
        afterWarmupBytes,
        medianBytes: percentile(sorted, 0.5),
        sampledMaxBytes: sorted.at(-1) as number,
        samples: samples.length,
        lifetimeMaxBytes: server.resourceUsage()?.maxRSS,
      },
    };
  } finally {
    finished = true;
    if (load && load.exitCode === null) {
      load.kill();
      await load.exited;
    }
    await samplesPromise;
    if (server.exitCode === null) {
      server.kill();
    }
    await server.exited;
    await serverErrors;
  }
}

async function save(): Promise<void> {
  const summary = concurrencies.flatMap((concurrency) =>
    modes.map((workers) => {
      const runs = measurements.filter((result) => result.workers === workers && result.concurrency === concurrency);
      const metric = (select: (run: Measurement) => number) => {
        const values = runs.map(select).sort((a, b) => a - b);
        const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
        const deviation = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
        return { median: percentile(values, 0.5), min: values[0], max: values.at(-1), cv: deviation / mean };
      };
      return {
        workers,
        concurrency,
        rounds: runs.length,
        requests: runs.reduce((sum, run) => sum + run.requests, 0),
        failures: runs.reduce((sum, run) => sum + run.failures, 0),
        requestsPerSecond: metric((run) => run.requestsPerSecond),
        p50Ms: metric((run) => run.latency.p50Ms),
        p95Ms: metric((run) => run.latency.p95Ms),
        p99Ms: metric((run) => run.latency.p99Ms),
        healthP95Ms: metric((run) => run.health.p95Ms),
        rssMedianBytes: metric((run) => run.rss.medianBytes),
        rssSampledMaxBytes: metric((run) => run.rss.sampledMaxBytes),
        openMs: metric((run) => run.openMs),
      };
    })
  );
  await Bun.write(
    outputPath,
    JSON.stringify(
      {
        metadata,
        protocol: {
          rounds,
          durationMs,
          warmupPasses: 2,
          warmupMs,
          concurrencies,
          modes,
          maxQueue,
          rssSampleIntervalMs: 100,
          healthProbeIntervalMs: 100,
          freshServerAndClientPerMeasurement: true,
          requestModel: 'closed-loop',
          limit: 10,
          latencyBoundary: 'client fetch start to complete response body',
          rssScope: 'server process, including all workers; excludes client and sampler',
          distribution: 'equal round-robin over all queries, shared sequence across connections',
          cases: cases.map(({ query, path }) => ({ query, path })),
        },
        completed: measurements.length === rounds * concurrencies.length * modes.length,
        summary,
        measurements,
      },
      null,
      2,
    ),
  );
}
