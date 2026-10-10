export type HttpBenchmarkCase = { query: string; path: string; expectedBody: string; };

export type HttpLatency = { samples: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number; };

export type HttpLoadResult = {
  elapsedMs: number;
  requests: number;
  successfulRequests: number;
  requestsPerSecond: number;
  failures: number;
  firstFailure?: string;
  statusCounts: Record<string, number>;
  latency: HttpLatency;
  byQuery: { query: string; latency: HttpLatency; }[];
  health: HttpLatency;
};

export type HttpServerReady = { url: string; openMs: number; };

export function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

export function latency(values: number[]): HttpLatency {
  values.sort((a, b) => a - b);
  return {
    samples: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: values.at(-1) ?? 0,
  };
}
