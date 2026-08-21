import {
  bench,
  run,
  summary,
} from 'mitata';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DneDatabaseWriter } from '../src/db.ts';
import {
  resolveDirectoryDneSource,
  resolveZipDneSource,
  type DneDataSource,
} from '../src/dne-source.ts';
import {
  buildSchema,
  getTableFilesGlob,
  type TableDefinition,
} from '../src/schema.ts';

const rows = Number(Bun.argv[2] ?? '5000');
const workDir = mkdtempSync(join(tmpdir(), 'edne-direct-zip-benchmark-'));
const dneDir = join(workDir, 'dne');
const zipPath = join(workDir, 'dne.zip');
const schema = buildSchema();
let databaseCounter = 0;
const nestedZipPath = join(workDir, 'inner.zip');

runCommand('bun', ['run', 'bench/create-dne.bench.ts', dneDir, String(rows)]);
runCommand('zip', ['-qr', zipPath, 'Delimitado'], dneDir);

const zipBuffer = Buffer.from(await Bun.file(zipPath).arrayBuffer());
const directorySource = resolveDirectoryDneSource(dneDir, schema);
if (!directorySource) {
  throw new Error(`Failed to resolve generated DNE directory: ${dneDir}`);
}

const zipSource = await resolveZipDneSource(zipPath, schema, nestedZipPath);
const requiredFiles = collectRequiredFiles(zipSource, schema);
const zipBytes = zipBuffer.length;
const textBytes = await readAllText(zipSource, requiredFiles);

console.log(
  JSON.stringify({ rowsPerMainTable: rows, zipBytes, textBytes, requiredFiles: requiredFiles.length }, null, 2),
);

summary(() => {
  bench('direct ZIP resolve central directory', async () => {
    await resolveZipDneSource(zipPath, schema, nestedZipPath);
  });

  bench('directory read all required TXT', async () => {
    await readAllText(directorySource, requiredFiles);
  });

  bench('direct ZIP read all required TXT', async () => {
    await readAllText(await resolveZipDneSource(zipPath, schema, nestedZipPath), requiredFiles);
  });

  bench('directory load SQLite', async () => {
    await loadSqlite(directorySource);
  });

  bench('direct ZIP load SQLite', async () => {
    await loadSqlite(await resolveZipDneSource(zipPath, schema, nestedZipPath));
  });
});

await run({ colors: !envValue('NO_COLOR') });
rmSync(workDir, { recursive: true, force: true });

function envValue(name: string) {
  return Bun.env[name];
}

function collectRequiredFiles(source: DneDataSource, tables: TableDefinition[]) {
  const files: string[] = [];

  for (const table of tables) {
    const glob = getTableFilesGlob(table);
    if (!glob) {
      continue;
    }
    files.push(...source.matchingFiles(glob));
  }

  return files;
}

async function readAllText(source: DneDataSource, files: string[]) {
  let bytes = 0;
  for (const file of files) {
    for await (const line of source.readLines(file)) {
      bytes += line.length;
    }
  }
  return bytes;
}

async function loadSqlite(source: DneDataSource) {
  const databasePath = join(workDir, `benchmark-${databaseCounter++}.db`);
  const writer = new DneDatabaseWriter(databasePath, schema);

  try {
    await writer.loadFromSource(source, { source_kind: 'benchmark' });
  } finally {
    writer.close();
    rmSync(databasePath, { force: true });
  }
}

function runCommand(command: string, args: string[], cwd = process.cwd()) {
  const result = spawnSync(command, args, { cwd, stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}\n${result.stderr.toString()}`);
  }
}
