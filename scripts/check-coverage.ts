import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const COVERAGE_THRESHOLDS = {
  functions: 1,
  lines: 1,
};
const reportPath = resolve(Bun.argv[2] ?? 'coverage/lcov.info');
const report = await readFile(reportPath, 'utf8');

const lines = coverageMetric(report, 'LF', 'LH');
const functions = coverageMetric(report, 'FNF', 'FNH');

for (
  const [metric, threshold,] of [
    [lines, COVERAGE_THRESHOLDS.lines],
    [functions, COVERAGE_THRESHOLDS.functions],
  ] as const
) {
  if (metric.ratio < threshold) {
    throw new Error(
      `${metric.name} coverage ${(metric.ratio * 100).toFixed(2)}% is below ${(threshold * 100).toFixed(0)}%`,
    );
  }
}

console.log(
  `Cobertura agregada: linhas ${(lines.ratio * 100).toFixed(2)}%, funções ${(functions.ratio * 100).toFixed(2)}%.`,
);

function coverageMetric(report: string, foundKey: string, hitKey: string) {
  const found = sumMetric(report, foundKey);
  const hit = sumMetric(report, hitKey);
  if (!found) {
    throw new Error(`Coverage report has no ${foundKey} entries`);
  }
  return {
    name: foundKey === 'LF' ? 'line' : 'function',
    ratio: hit / found,
  };
}

function sumMetric(report: string, key: string) {
  const prefix = `${key}:`;
  return report
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .reduce((total, line) => total + Number(line.slice(prefix.length)), 0);
}
