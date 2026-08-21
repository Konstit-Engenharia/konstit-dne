import { DneDatabaseWriter } from '../src/db.ts';
import {
  resolveBufferedZipDneSource,
  resolveZipDneSource,
} from '../src/dne-source.ts';
import { buildSchema } from '../src/schema.ts';
import { SQLITE_CEP_TABLE_NAME } from '../src/settings.ts';

const [mode, zipPath, databasePath, nestedZipPath,] = Bun.argv.slice(2);
if (
  (mode !== 'buffered' && mode !== 'streamed')
  || !zipPath
  || !databasePath
  || !nestedZipPath
) {
  console.error(
    'Usage: bun run bench/zip-stream-worker.bench.ts <buffered|streamed> <source.zip> <database.db> <inner.zip>',
  );
  process.exit(1);
}

const schema = buildSchema({ cep_unificado: SQLITE_CEP_TABLE_NAME });
const startedAt = performance.now();
const writer = new DneDatabaseWriter(databasePath, schema);
let resolveSeconds: number;
let loadSeconds: number;
try {
  const resolveStartedAt = performance.now();
  const source = mode === 'buffered'
    ? resolveBufferedZipDneSource(
      Buffer.from(await Bun.file(zipPath).arrayBuffer()),
      schema,
    )
    : await resolveZipDneSource(zipPath, schema, nestedZipPath);
  resolveSeconds = secondsSince(resolveStartedAt);

  const loadStartedAt = performance.now();
  await writer.loadFromSource(source, { source_kind: `benchmark-${mode}` });
  loadSeconds = secondsSince(loadStartedAt);
} finally {
  writer.close();
}

console.log(
  JSON.stringify({
    mode,
    totalSeconds: secondsSince(startedAt),
    resolveSeconds,
    loadSeconds,
    maxRssMiB: round(process.resourceUsage().maxRSS / 1024),
  }),
);

function secondsSince(start: number) {
  return round((performance.now() - start) / 1000);
}

function round(value: number) {
  return Number(value.toFixed(3));
}
