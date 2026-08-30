import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const size = Number(Bun.argv[2] ?? '5000');
const workDir = join(tmpdir(), `edne-correios-loader-benchmark-${Date.now()}`);
const dneDir = join(workDir, 'dne');
const bunDb = join(workDir, 'bun.db');

await rm(workDir, { recursive: true, force: true });

const fixtureSeconds = timed('bun', ['run', 'bench/create-dne.bench.ts', dneDir, String(size)]);

const bun = timed('bun', [
  'run',
  'src/index.ts',
  'build',
  bunDb,
  '--source',
  dneDir,
]);

console.log({ rowsPerMainTable: size, fixtureSeconds, bunSeconds: bun, bunDb });

function timed(command: string, args: string[]) {
  const start = performance.now();
  run(command, args);
  return Number(((performance.now() - start) / 1000).toFixed(3));
}

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: process.cwd() });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
  }
}
