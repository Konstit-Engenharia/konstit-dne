import {
  bench,
  run,
} from 'mitata';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const sizes = (Bun.argv[2] ?? '1,25,50,100,250,500,1000,1500,2000')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);

const rows = Array.from(
  { length: 2000 },
  (_, index) =>
    [
      String(30000000 + index),
      `Rua Endereco ${index}`,
      null,
      `Bairro ${index}`,
      `Municipio ${index}`,
      3500000 + index,
      index % 2 === 0 ? 'SP' : 'BA',
      null,
    ] as const,
);

for (const size of sizes) {
  bench(`flatten insert rows batch=${size}`, () => {
    const batch = rows.slice(0, size);
    const params = Array.from({ length: batch.length * 8 }, () => null as string | number | null);
    for (let rowIndex = 0; rowIndex < batch.length; rowIndex++) {
      const row = batch[rowIndex];
      if (!row) {
        throw new Error(`Missing row at index ${rowIndex}`);
      }
      const offset = rowIndex * 8;
      params[offset] = row[0];
      params[offset + 1] = row[1];
      params[offset + 2] = row[2];
      params[offset + 3] = row[3];
      params[offset + 4] = row[4];
      params[offset + 5] = row[5];
      params[offset + 6] = row[6];
      params[offset + 7] = row[7];
    }
    return params;
  });
}

await run({ colors: !process.env['NO_COLOR'] });

console.log('\nreal cached load:');
for (const size of sizes) {
  const db = `/tmp/edne-batch-size-${size}.db`;
  rmSync(db, { force: true });
  const start = performance.now();
  const result = spawnSync('bun', ['run', 'src/index.ts', 'fetch', db], {
    cwd: process.cwd(),
    env: { ...process.env, EDNE_INSERT_BATCH_SIZE: String(size) },
    stdio: 'pipe',
  });
  const seconds = Number(((performance.now() - start) / 1000).toFixed(3));
  if (result.status !== 0) {
    throw new Error(`batch=${size} failed\n${result.stderr.toString()}`);
  }
  console.log(`batch=${size} seconds=${seconds}`);
}
