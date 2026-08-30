import { spawnSync } from 'node:child_process';
import {
  mkdir,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workDir = join(tmpdir(), `edne-correios-loader-download-benchmark-${Date.now()}`);
const bunDb = join(workDir, 'bun.db');

await rm(workDir, { recursive: true, force: true });
await mkdir(workDir, { recursive: true });

const bun = timed('bun', ['run', 'src/index.ts', 'fetch', bunDb]);

console.log(
  JSON.stringify(
    {
      workDir,
      bunDb,
      bunSeconds: bun,
    },
    null,
    2,
  ),
);

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
