#!/usr/bin/env bun

import {
  command,
  flag,
  option,
  parsers,
  positional,
} from '@konstit/cli';
import { Database } from 'bun:sqlite';
import {
  copyFile,
  mkdir,
  rename,
  rm,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  join,
} from 'node:path';
import {
  createPrettyTableSql,
  createTableSql,
  DneDatabaseWriter,
  hasTable,
  quoteIdent,
  readDatabaseMetadata,
  sqlitePathFromDatabaseUrl,
  type LoadMetadata,
} from './db.ts';
import {
  DneResolver,
  inspectRemoteDneSource,
  type RemoteDneSourceInfo,
} from './resolver.ts';
import { buildSchema } from './schema.ts';
import {
  BINARY_NAME,
  EDNE_DOWNLOAD_URL,
  SQLITE_CEP_TABLE_NAME,
  SQLITE_FILE_NAME,
  SQLITE_METADATA_TABLE_NAME,
} from './settings.ts';

const SQLITE_CEP_ORIGINAL_TABLE_NAME = 'cep_unificado';
const REMOTE_LAST_MODIFIED_TOLERANCE_MS = 10 * 60 * 1000;
const ANSI_RESET = '\x1b[0m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_CYAN = '\x1b[36m';

const cli = command(BINARY_NAME, {
  version: '1.0.0',
  subcommands: [
    command('fetch', {
      args: [
        positional('path', parsers.string, {
          default: SQLITE_FILE_NAME,
          describe: 'Path to the SQLite database file.',
        }),
        option('source', parsers.string, {
          default: EDNE_DOWNLOAD_URL,
          describe: 'Path, ZIP, or URL of the DNE data.',
        }),
        flag('force', {
          describe: 'Force fetch and rebuild even if the database is up-to-date',
        }),
      ],
      about: 'Build a SQLite database from DNE data',
      handler: fetchDatabase,
    }),
    command('lookup', {
      args: [
        positional('db', parsers.string, {
          required: true,
          valueName: 'DATABASE-PATH',
          describe: 'Path to the SQLite database file.',
        }),
        positional('cep', parsers.string, {
          required: true,
          describe: 'CEP to query',
        }),
      ],
      about: 'Lookup a CEP in the database',
      handler: lookupCep,
    }),
    command('schema', {
      args: [
        positional('path', parsers.string, {
          default: SQLITE_FILE_NAME,
          describe: 'Path to the SQLite database file.',
        }),
      ],
      about: 'Display the CEP table schema',
      handler: showSchema,
    }),
  ],
  subcommandRequired: true,
  defaultToHelp: true,
});

process.exitCode = await cli.run();

type FetchOptions = {
  path: string;
  source: string;
  force: boolean;
};

type LookupOptions = {
  cep: string;
  db: string;
};

async function fetchDatabase(options: FetchOptions) {
  const schema = buildDneSchema();
  const sourceInput = options.source;
  const databaseUrl = options.path;
  const target = sqlitePathFromDatabaseUrl(databaseUrl);
  const shouldUpdateInPlace = target !== ':memory:' && await Bun.file(target).exists();
  const remoteInfo = looksLikeUrl(sourceInput)
    ? await inspectRemoteDneSource(sourceInput)
    : null;

  if (
    !options.force
    && remoteInfo
    && (await databaseIsCurrent(target, SQLITE_CEP_TABLE_NAME, remoteInfo))
  ) {
    console.log(
      `DNE source unchanged since ${remoteInfo.lastModified ?? 'previous load'}; skipping download and load`,
    );
    return;
  }

  const resolver = new DneResolver(sourceInput, { skipCache: options.force });
  const scratch = await createScratchTarget(target);
  const writer = new DneDatabaseWriter(scratch.path, schema);
  let closed = false;

  try {
    const source = await resolver.resolve(schema);
    await writer.loadFromSource(
      source,
      buildLoadMetadata(sourceInput, remoteInfo),
    );
    writer.close();
    closed = true;
    if (shouldUpdateInPlace) {
      await replaceTargetFromScratch(target, scratch.path, schema);
    } else {
      await scratch.commit();
    }
  } finally {
    if (!closed) {
      writer.close();
    }
    await scratch.cleanup();
    await resolver.cleanup();
  }
}

function lookupCep(options: LookupOptions) {
  const schema = buildDneSchema();
  const writer = new DneDatabaseWriter(
    sqlitePathFromDatabaseUrl(options.db),
    schema,
  );

  try {
    const row = writer.queryCep(SQLITE_CEP_TABLE_NAME, options.cep);
    if (!row) {
      console.error('CEP not found');
      process.exitCode = 3;
      return;
    }
    console.log(row);
  } finally {
    writer.close();
  }
}

function showSchema() {
  const schema = buildDneSchema();
  const cepTable = schema.find((table) => table.originalName === SQLITE_CEP_ORIGINAL_TABLE_NAME);
  if (!cepTable) {
    throw new Error(`Missing schema table '${SQLITE_CEP_ORIGINAL_TABLE_NAME}'`);
  }
  console.log(renderSqlMarkdown(createPrettyTableSql(cepTable)));
}

function buildDneSchema() {
  return buildSchema({ [SQLITE_CEP_ORIGINAL_TABLE_NAME]: SQLITE_CEP_TABLE_NAME });
}

async function replaceTargetFromScratch(
  targetPath: string,
  scratchPath: string,
  schema: ReturnType<typeof buildDneSchema>,
) {
  const cepTable = schema.find((table) => table.originalName === SQLITE_CEP_ORIGINAL_TABLE_NAME);
  if (!cepTable) {
    throw new Error(`Missing schema table '${SQLITE_CEP_ORIGINAL_TABLE_NAME}'`);
  }

  const columns = cepTable.columns.map((column) => quoteIdent(column.name)).join(', ');
  const attachPath = `${scratchPath}.attach`;
  await rm(attachPath, { force: true });
  await copyFile(scratchPath, attachPath);
  const db = new Database(targetPath);

  try {
    db.run('PRAGMA busy_timeout = 30000');
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA synchronous = NORMAL');
    db.run(`ATTACH DATABASE ${quoteLiteral(attachPath)} AS fresh`);
    db.run('BEGIN IMMEDIATE');
    try {
      db.run(createTableSql(cepTable));
      db.run(`
        CREATE TABLE IF NOT EXISTS ${quoteIdent(SQLITE_METADATA_TABLE_NAME)} (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        )
      `);
      db.run(`DELETE FROM main.${quoteIdent(SQLITE_CEP_TABLE_NAME)}`);
      db.run(`
        INSERT INTO main.${quoteIdent(SQLITE_CEP_TABLE_NAME)} (${columns})
        SELECT ${columns}
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
    await rm(attachPath, { force: true });
  }
}

async function databaseIsCurrent(
  databasePath: string,
  cepTableName: string,
  remoteInfo: RemoteDneSourceInfo,
) {
  if (!(await hasTable(databasePath, cepTableName))) {
    return false;
  }

  const metadata = await readDatabaseMetadata(databasePath);
  if (!metadata) {
    return false;
  }

  return (
    metadata.source_kind === 'remote'
    && metadata.source_url === remoteInfo.url
    && metadata.source_content_length === (remoteInfo.contentLength ?? '')
    && remoteLastModifiedMatches(
      metadata.source_last_modified,
      remoteInfo.lastModified,
    )
    && remoteEtagMatchesWhenNeeded(metadata.source_etag, remoteInfo)
  );
}

function remoteLastModifiedMatches(
  previous: string | undefined,
  current: string | null,
) {
  if (!previous && !current) {
    return true;
  }
  if (!previous || !current) {
    return false;
  }
  if (previous === current) {
    return true;
  }

  const previousTime = Date.parse(previous);
  const currentTime = Date.parse(current);
  if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime)) {
    return false;
  }

  return (
    Math.abs(previousTime - currentTime) <= REMOTE_LAST_MODIFIED_TOLERANCE_MS
  );
}

function remoteEtagMatchesWhenNeeded(
  previous: string | undefined,
  current: RemoteDneSourceInfo,
) {
  if (current.lastModified) {
    return true;
  }
  return (previous ?? '') === (current.etag ?? '');
}

function buildLoadMetadata(
  source: string,
  remoteInfo: RemoteDneSourceInfo | null,
) {
  const metadata: LoadMetadata = {
    loaded_at: new Date().toISOString(),
    source_input: source,
    source_kind: remoteInfo
      ? 'remote'
      : looksLikeUrl(source)
      ? 'remote'
      : 'local',
  };

  if (remoteInfo) {
    metadata.source_url = remoteInfo.url;
    metadata.source_last_modified = remoteInfo.lastModified ?? '';
    metadata.source_etag = remoteInfo.etag ?? '';
    metadata.source_content_length = remoteInfo.contentLength ?? '';
  }

  return metadata;
}

function looksLikeUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function quoteLiteral(value: string) {
  return `'${value.replaceAll('\'', '\'\'')}'`;
}

function renderSqlMarkdown(sql: string) {
  return Bun.markdown.render(`\`\`\`sql\n${sql}\n\`\`\``, {
    code: (children) => renderSqlCodeBlock(children),
  }).trimEnd();
}

function renderSqlCodeBlock(sql: string) {
  if (!shouldUseAnsi()) {
    return sql;
  }

  return sql
    .replaceAll(/"([^"]+)"/g, `${ANSI_CYAN}"$1"${ANSI_RESET}`)
    .replaceAll(
      /\b(CREATE|TABLE|IF|NOT|EXISTS|TEXT|INTEGER|NULL|PRIMARY|KEY|WITHOUT|ROWID)\b/g,
      `${ANSI_BOLD}$1${ANSI_RESET}`,
    );
}

function shouldUseAnsi() {
  return Boolean(process.stdout.isTTY) && envValue('NO_COLOR') === undefined;
}

function envValue(name: string) {
  return Bun.env[name];
}

async function createScratchTarget(target: string) {
  if (target === ':memory:') {
    return {
      path: target,
      commit: async () => {},
      cleanup: async () => {},
    };
  }

  const finalPath = dirname(target) === '.' ? join(process.cwd(), target) : target;
  const directory = dirname(finalPath);
  const scratch = join(
    directory,
    `.${basename(finalPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await mkdir(directory, { recursive: true });
  await rm(scratch, { force: true });

  let committed = false;
  return {
    path: scratch,
    commit: async () => {
      await rename(scratch, finalPath);
      committed = true;
    },
    cleanup: async () => {
      if (!committed) {
        await rm(scratch, { force: true });
      }
      await rm(`${scratch}-journal`, { force: true });
    },
  };
}
