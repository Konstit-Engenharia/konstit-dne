import {
  latency,
  type HttpBenchmarkCase,
  type HttpLoadResult,
} from './address-search-http-common.ts';

const [baseUrl, casesPath, concurrencyText, durationText, warmupText,] = Bun.argv.slice(2) as [string, string, string, string, string];
const cases = await Bun.file(casesPath).json() as HttpBenchmarkCase[];
const concurrency = Number(concurrencyText);
const measuredMs = Number(durationText);
const warmupMs = Number(warmupText);
const urls = cases.map(({ path }) => new URL(path, baseUrl).href);

/** Closed loop: each connection starts its next request only after consuming the previous response body. */
async function load(durationMs: number, probeHealth: boolean): Promise<HttpLoadResult> {
  const durations: number[] = [];
  const perQuery = cases.map(() => [] as number[]);
  const health: number[] = [];
  const probes: Promise<void>[] = [];
  const statusCounts: Record<string, number> = {};
  let failures = 0;
  let firstFailure: string | undefined;
  let ticket = 0;
  const start = performance.now();
  const deadline = start + durationMs;
  const healthTimer = probeHealth
    ? setInterval(() => {
      probes.push((async () => {
        const begin = performance.now();
        const response = await fetch(new URL('/health', baseUrl));
        if (response.status !== 200 || await response.text() !== 'ok') {
          throw new Error('Health probe failed');
        }
        health.push(performance.now() - begin);
      })());
    }, 100)
    : undefined;
  try {
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (performance.now() < deadline) {
        const caseIndex = ticket++ % cases.length;
        const begin = performance.now();
        try {
          const response = await fetch(urls[caseIndex] as string);
          const body = await response.text();
          const elapsed = performance.now() - begin;
          statusCounts[response.status] = (statusCounts[response.status] ?? 0) + 1;
          if (response.status !== 200 || body !== (cases[caseIndex] as HttpBenchmarkCase).expectedBody) {
            failures++;
            firstFailure ??= `${response.status}: ${body.slice(0, 200)}`;
          } else {
            durations.push(elapsed);
            (perQuery[caseIndex] as number[]).push(elapsed);
          }
        } catch (error) {
          failures++;
          firstFailure ??= String(error);
        }
      }
    }));
  } finally {
    clearInterval(healthTimer);
  }
  // Include draining requests started before the deadline in the throughput denominator.
  const elapsedMs = performance.now() - start;
  await Promise.all(probes);
  return {
    elapsedMs,
    requests: ticket,
    successfulRequests: durations.length,
    requestsPerSecond: durations.length / (elapsedMs / 1_000),
    failures,
    firstFailure,
    statusCounts,
    latency: latency(durations),
    byQuery: cases.map(({ query }, index) => ({ query, latency: latency(perQuery[index] as number[]) })),
    health: latency(health),
  };
}

for (let warmup = 0; warmup < 2; warmup++) {
  const result = await load(warmupMs, false);
  if (result.failures) {
    throw new Error(`Warmup failed: ${result.firstFailure}`);
  }
}

// Wait for the external RSS sampler before starting the measured requests.
const go = Promise.withResolvers<void>();
process.once('message', () => go.resolve());
process.send?.('warm');
await go.promise;
console.log(JSON.stringify(await load(measuredMs, true)));
process.disconnect?.();
