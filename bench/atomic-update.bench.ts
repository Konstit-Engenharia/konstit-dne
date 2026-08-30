import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SQLITE_CEP_TABLE_NAME,
  SQLITE_METADATA_TABLE_NAME,
} from '../src/settings.ts';

const oldRows = Number(Bun.argv[2] ?? '1000');
const newRows = Number(Bun.argv[3] ?? '50000');
const workDir = mkdtempSync(join(tmpdir(), 'edne-atomic-update-benchmark-'));
const oldDneDir = join(workDir, 'old-dne');
const newDneDir = join(workDir, 'new-dne');
const targetDbPath = join(workDir, 'target.db');
const scratchDbPath = join(workDir, 'scratch.db');

try {
  runCommand('bun', ['run', 'bench/create-dne.bench.ts', oldDneDir, String(oldRows)]);
  runCommand('bun', ['run', 'bench/create-dne.bench.ts', newDneDir, String(newRows)]);

  loadDatabase(targetDbPath, oldDneDir);
  loadDatabase(scratchDbPath, newDneDir);

  const liveDb = new Database(targetDbPath);
  try {
    const beforeCount = countRows(liveDb);
    const scratchDb = new Database(scratchDbPath, { readonly: true });
    const scratchCount = countRows(scratchDb);
    scratchDb.close();

    const updateSeconds = timed(() => {
      atomicReplaceFromScratch(targetDbPath, scratchDbPath);
    });

    const afterCountSameConnection = countRows(liveDb);
    const afterMetadataSameConnection = metadataValue(liveDb, 'source_kind');
    const sidecarsAfterCommit = [
      `${targetDbPath}-journal`,
      `${targetDbPath}-wal`,
      `${targetDbPath}-shm`,
    ].filter((path) => existsSync(path));

    console.log(
      JSON.stringify(
        {
          oldRowsPerMainTable: oldRows,
          newRowsPerMainTable: newRows,
          beforeCount,
          scratchCount,
          afterCountSameConnection,
          afterMetadataSameConnection,
          updateSeconds,
          sidecarsAfterCommit,
          targetDbPath,
          scratchDbPath,
        },
        null,
        2,
      ),
    );
  } finally {
    liveDb.close();
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function loadDatabase(databasePath: string, sourceDir: string) {
  runCommand('bun', ['run', 'src/index.ts', 'build', '--db', databasePath, '--source', sourceDir]);
}

function atomicReplaceFromScratch(targetPath: string, scratchPath: string) {
  const attachPath = `${scratchPath}.attach`;
  rmSync(attachPath, { force: true });
  copyFileSync(scratchPath, attachPath);
  const db = new Database(targetPath);
  try {
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA synchronous = NORMAL');
    db.run(`ATTACH DATABASE ${quoteLiteral(attachPath)} AS fresh`);
    db.run('BEGIN IMMEDIATE');
    try {
      db.run(`DELETE FROM main.${quoteIdent(SQLITE_CEP_TABLE_NAME)}`);
      db.run(`
        INSERT INTO main.${quoteIdent(SQLITE_CEP_TABLE_NAME)}
          (cep, logradouro, complemento, bairro, municipio, municipio_cod_ibge, uf, nome)
        SELECT cep, logradouro, complemento, bairro, municipio, municipio_cod_ibge, uf, nome
        FROM fresh.${quoteIdent(SQLITE_CEP_TABLE_NAME)}
      `);
      db.run(`DELETE FROM main.${quoteIdent(SQLITE_METADATA_TABLE_NAME)}`);
      db.run(`
        INSERT INTO main.${quoteIdent(SQLITE_METADATA_TABLE_NAME)} (key, value)
        SELECT key, value
        FROM fresh.${quoteIdent(SQLITE_METADATA_TABLE_NAME)}
      `);
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    } finally {
      db.run('DETACH DATABASE fresh');
    }
  } finally {
    db.close();
    rmSync(attachPath, { force: true });
  }
}

function countRows(db: Database) {
  return (
    db.query(`SELECT count(*) AS count FROM ${quoteIdent(SQLITE_CEP_TABLE_NAME)}`).get() as {
      count: number;
    }
  ).count;
}

function metadataValue(db: Database, key: string) {
  return (
    db.query(`SELECT value FROM ${quoteIdent(SQLITE_METADATA_TABLE_NAME)} WHERE key = ?`).get(key) as {
      value: string;
    } | null
  )?.value ?? null;
}

function timed(fn: () => void) {
  const start = performance.now();
  fn();
  return Number(((performance.now() - start) / 1000).toFixed(3));
}

function runCommand(command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd: process.cwd(), stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}\n${result.stderr.toString()}`);
  }
}

function quoteIdent(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string) {
  return `'${value.replaceAll('\'', '\'\'')}'`;
}
