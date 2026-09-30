import {
  colorFlag,
  command,
  flag,
  option,
  parsers,
  positional,
  type HandlerContext,
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
import { buildBinaryDatabase } from './binary-db-writer.ts';
import {
  collectCepInputs,
  normalizeCep,
} from './cep.ts';
import {
  installCronSchedule,
  removeCronSchedule,
  showCronSchedule,
} from './cron-service.ts';
import {
  databasePath,
  inspectDatabase,
  memoryDatabaseInspection,
  openReadyDatabase,
  type DatabaseFormat,
  type DatabaseInspection,
} from './database-service.ts';
import {
  createPrettyTableSql,
  DneDatabaseWriter,
  DneSourceQualityError,
  prepareTableForLoad,
  quoteIdent,
  type DneRow,
} from './db.ts';
import { UserError } from './errors.ts';
import { acquireFetchLock } from './fetch-lock.ts';
import {
  DneResolver,
  inspectRemoteDneSource,
  type RemoteDneSourceInfo,
} from './resolver.ts';
import {
  buildSchema,
  getUnifiedTable,
} from './schema.ts';
import {
  BINARY_NAME,
  EDNE_DOWNLOAD_URL,
  SQLITE_CEP_TABLE_NAME,
  SQLITE_FILE_NAME,
  SQLITE_METADATA_TABLE_NAME,
} from './settings.ts';
import {
  buildLoadMetadata,
  remoteMetadataMatches,
} from './update-policy.ts';

const DEFAULT_CRON_EXPRESSION = '0 0 * * 5';
const ANSI_RESET = '\x1b[0m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_CYAN = '\x1b[36m';
const ANSI_GRAY = '\x1b[90m';
const SQL_HIGHLIGHT_PATTERN =
  /(--[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[(?:]]|[^\]])*]|\b(?:CREATE|TABLE|IF|NOT|EXISTS|TEXT|INTEGER|NULL|PRIMARY|KEY|WITHOUT|ROWID)\b)/gi;
const DISPLAY_LOCALE = 'pt-BR';
const INTEGER_FORMAT = new Intl.NumberFormat(DISPLAY_LOCALE);
const DECIMAL_FORMAT = new Intl.NumberFormat(DISPLAY_LOCALE, {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});
const DURATION_SECONDS_FORMAT = new Intl.NumberFormat(DISPLAY_LOCALE, {
  maximumFractionDigits: 1,
});
const EXIT_FAILURE = 1;
const EXIT_INVALID_INPUT = 2;
const EXIT_NOT_FOUND = 3;

const VERSION = await readPackageVersion();
const databaseArgument = option('db', parsers.string, {
  default: SQLITE_FILE_NAME,
  describe: 'Caminho da base; build binário usa a extensão .bin.',
  global: true,
  valueHint: 'file',
  valueName: 'CAMINHO',
});
const jsonArgument = flag('json', {
  describe: 'Gravar um envelope JSON estável em stdout.',
  global: true,
});
const quietArgument = flag('quiet', {
  describe: 'Ocultar mensagens de progresso.',
  global: true,
  short: 'q',
});
const colorArgument = colorFlag('color');

/**
 * Configured command tree for building, querying, inspecting, and scheduling DNE databases.
 */
export const cli = command(BINARY_NAME, {
  about: 'Criar e consultar uma base local com os CEPs do Brasil.',
  afterHelp: [
    'Exemplos:',
    '  bunx @konstit/dne build --db ./dne.db',
    '  bunx @konstit/dne build --format binary',
    '  bunx @konstit/dne get 01001-000 --db ./dne.db',
    '  bunx @konstit/dne status --db ./dne.db',
    '  bunx @konstit/dne cron install --db ./dne.db',
  ].join('\n'),
  args: [databaseArgument, jsonArgument, quietArgument, colorArgument],
  version: VERSION,
  subcommands: [
    command('build', {
      args: [
        option('format', parsers.enum(['sqlite', 'binary'] as const), {
          default: 'sqlite',
          describe: 'Formato da base de saída.',
          valueName: 'sqlite|binary',
        }),
        option('source', parsers.string, {
          default: EDNE_DOWNLOAD_URL,
          describe: 'Diretório DNE, arquivo ZIP ou URL.',
          valueName: 'CAMINHO|URL',
        }),
        flag('force', {
          describe: 'Ignorar metadados de atualização e recriar a base.',
        }),
        flag('check', {
          describe: 'Verificar a atualização da fonte sem alterar a base.',
        }),
      ],
      about: 'Criar ou atualizar a base SQLite ou binária',
      conflicts: [['force', 'check']],
      handler: (args, context) => fetchDatabase(args, globalOptions(context)),
    }),
    command('get', {
      args: [
        positional('input', parsers.string, {
          describe: 'Um ou mais CEPs.',
          repeatable: true,
          valueName: 'CEP',
        }),
        option('file', parsers.string, {
          describe: 'Ler CEPs de um arquivo. Use - para stdin.',
          valueHint: 'file',
          valueName: 'CAMINHO',
        }),
        flag('jsonl', {
          describe: 'Gravar um resultado JSON por linha.',
        }),
      ],
      about: 'Consultar um ou mais CEPs',
      handler: (args, context) => lookupCep(args, globalOptions(context)),
    }),
    command('status', {
      about: 'Exibir tamanho, registros, estado do esquema e metadados da fonte',
      handler: (_args, context) => showStatus(globalOptions(context)),
    }),
    command('schema', {
      args: [
        flag('expected', {
          describe: 'Exibir o esquema declarado pela CLI em vez do esquema da base.',
        }),
      ],
      about: 'Exibir o esquema atual ou esperado da tabela de CEPs',
      handler: (args, context) => showSchema(args, globalOptions(context)),
    }),
    command('doctor', {
      args: [
        flag('offline', {
          describe: 'Não verificar a fonte remota.',
        }),
        option('source', parsers.string, {
          default: EDNE_DOWNLOAD_URL,
          describe: 'URL da fonte remota que será verificada.',
          valueName: 'URL',
        }),
      ],
      about: 'Verificar Bun, configuração da base e acesso à fonte',
      handler: (args, context) => doctor(args, globalOptions(context)),
    }),
    command('sql', {
      args: [
        positional('query', parsers.string, {
          describe: 'Instrução SELECT, WITH, PRAGMA ou EXPLAIN somente leitura.',
          required: true,
          valueName: 'CONSULTA',
        }),
        option('limit', parsers.range(1, 10_000), {
          default: 100,
          describe: 'Quantidade máxima de registros retornados.',
          valueName: 'REGISTROS',
        }),
      ],
      about: 'Executar uma consulta SQL somente leitura com limite',
      handler: (args, context) => querySql(args, globalOptions(context)),
    }),
    command('cron', {
      about: 'Gerenciar a atualização automática da base no sistema operacional',
      subcommands: [
        command('install', {
          args: [
            positional('expression', parsers.cron, {
              default: DEFAULT_CRON_EXPRESSION,
              describe: 'Expressão cron. O padrão executa à meia-noite de sexta-feira.',
              valueName: 'EXPRESSÃO',
            }),
            flag('dry-run', {
              describe: 'Exibir o agendamento sem alterar o sistema.',
            }),
            option('source', parsers.string, {
              describe: 'Diretório DNE, arquivo ZIP ou URL usado pelo agendamento.',
              valueName: 'CAMINHO|URL',
            }),
          ],
          about: 'Instalar ou substituir o agendamento desta base',
          handler: (args, context) => installCron(args, globalOptions(context)),
        }),
        command('status', {
          about: 'Exibir o agendamento desta base',
          handler: (_args, context) => showCronStatus(globalOptions(context)),
        }),
        command('remove', {
          about: 'Remover o agendamento desta base',
          handler: (_args, context) => removeCron(globalOptions(context)),
        }),
      ],
      subcommandRequired: true,
      defaultToHelp: true,
    }),
  ],
  subcommandRequired: true,
  defaultToHelp: true,
});

type GlobalOptions = {
  color: boolean;
  database: string;
  json: boolean;
  quiet: boolean;
};

type FetchOptions = {
  check: boolean;
  force: boolean;
  format: DatabaseFormat;
  source: string;
};

type LookupOptions = {
  file: string | undefined;
  input: readonly string[];
  jsonl: boolean;
};

type ProgressReporter = {
  (message: string): void;
  finish(): void;
};

type LookupResult = {
  address: DneRow | null;
  cep: string;
  found: boolean;
  input: string;
};

/**
 * Runs the CLI and renders localized text or structured JSON output.
 * @param argv - Arguments excluding the runtime and script names; defaults to Bun.argv after those entries.
 * @returns The process exit status. Expected command failures are rendered and converted to exit codes.
 */
export async function runCli(argv: readonly string[] = Bun.argv.slice(2)) {
  const jsonRequested = argv.includes('--json') || argv.includes('--jsonl');
  const stdoutUsesColor = process.stdout.isTTY === true && Bun.env['TERM'] !== 'dumb';

  try {
    return await cli.run({
      argv,
      color: stdoutUsesColor,
      stdout: (output: string) => console.log(localizeCliText(output).trimEnd()),
      ...(jsonRequested
        ? {
          stderr: (output: string) =>
            writeError(
              new UserError(
                'invalid-arguments',
                localizeCliText(firstErrorLine(Bun.stripANSI(output))),
                EXIT_INVALID_INPUT,
              ),
              true,
            ),
        }
        : {
          stderr: (output: string) => console.error(localizeCliText(output).trimEnd()),
        }),
    });
  } catch (error) {
    return reportFailure(error, jsonRequested);
  }
}

function globalOptions(context: HandlerContext): GlobalOptions {
  return {
    color: context.global(colorArgument),
    database: context.global(databaseArgument),
    json: context.global(jsonArgument),
    quiet: context.global(quietArgument),
  };
}

async function installCron(
  options: { 'dry-run': boolean; 'expression': string; 'source': string | undefined; },
  globals: GlobalOptions,
) {
  const result = await installCronSchedule({
    database: globals.database,
    dryRun: options['dry-run'],
    expression: options.expression,
    packageVersion: VERSION,
    source: options.source,
  });
  if (globals.json) {
    writeJson(result);
  } else {
    const action = result.status === 'preview'
      ? 'Agendamento que seria instalado'
      : result.status === 'updated'
      ? 'Agendamento atualizado'
      : 'Agendamento instalado';
    console.log(`${action}: ${result.expression}`);
    console.log(`Próxima execução: ${formatDateTime(result.next_run ?? undefined)}`);
    console.log(`Base: ${result.database}`);
    console.log(`Fonte: ${result.source}`);
    console.log(`Comando: ${result.command}`);
  }
  return 0;
}

function showCronStatus(globals: GlobalOptions) {
  const result = showCronSchedule(globals.database);

  if (globals.json) {
    writeJson(result);
  } else if (result.installed) {
    console.log(`Agendamento instalado: ${result.expression}`);
    console.log(`Próxima execução: ${formatDateTime(result.next_run ?? undefined)}`);
    console.log(`Base: ${result.database}`);
    console.log(`Fonte: ${result.source}`);
    console.log(`Pacote: @konstit/dne@${result.package_version}`);
    console.log(`Comando: ${result.command}`);
  } else {
    console.log(`Nenhum agendamento instalado para a base: ${result.database}`);
  }
  return 0;
}

async function removeCron(globals: GlobalOptions) {
  const output = await removeCronSchedule(globals.database);
  if (globals.json) {
    writeJson(output);
  } else if (output.removed) {
    console.log(`Agendamento removido para a base: ${output.database}`);
  } else {
    console.log(`Nenhum agendamento instalado para a base: ${output.database}`);
  }
  return 0;
}

async function fetchDatabase(options: FetchOptions, globals: GlobalOptions) {
  const progress = createProgress(globals.quiet);
  try {
    return await fetchDatabaseWithProgress(options, globals, progress);
  } finally {
    progress.finish();
  }
}

async function fetchDatabaseWithProgress(
  options: FetchOptions,
  globals: GlobalOptions,
  progress: ProgressReporter,
) {
  const startedAt = performance.now();
  const target = databasePath(globals.database, options.format);

  if (options.format === 'binary' && target === ':memory:') {
    throw new UserError('invalid-format', 'O formato binário exige um caminho de arquivo.', EXIT_INVALID_INPUT);
  }

  if (options.check || target === ':memory:') {
    return executeFetch(options, globals, progress, startedAt, target);
  }

  const lock = await acquireFetchLock(target, progress);
  try {
    return await executeFetch(options, globals, progress, startedAt, target);
  } finally {
    lock.release();
  }
}

async function executeFetch(
  options: FetchOptions,
  globals: GlobalOptions,
  progress: ProgressReporter,
  startedAt: number,
  target: string,
) {
  const schema = buildDneSchema();
  const sourceInput = options.source;
  const remoteInfo = looksLikeUrl(sourceInput)
    ? await inspectRemoteSource(sourceInput, progress)
    : null;
  progress.finish();

  if (options.check) {
    if (!remoteInfo) {
      const resolver = new DneResolver(sourceInput, { onProgress: progress });
      try {
        await resolver.resolve(schema);
      } catch (error) {
        throw new UserError('source-unavailable', humanErrorMessage(error));
      } finally {
        await resolver.cleanup();
        progress.finish();
      }
    }
    const inspection = await inspectDatabase(target);
    const upToDate = remoteInfo && inspection.ready
      ? await databaseIsCurrent(target, options.format, remoteInfo)
      : null;
    const result = {
      database: inspection,
      source: remoteSourceData(sourceInput, remoteInfo),
      status: upToDate === null ? 'unknown' : upToDate ? 'current' : 'update-available',
      up_to_date: upToDate,
    };
    writeFetchCheck(result, globals.json);
    return 0;
  }

  if (
    !options.force
    && remoteInfo
    && (await databaseIsCurrent(target, options.format, remoteInfo))
  ) {
    const inspection = await inspectDatabase(target);
    const result = {
      database: inspection,
      elapsed_ms: elapsedMilliseconds(startedAt),
      source: remoteSourceData(sourceInput, remoteInfo),
      status: 'unchanged',
    };
    writeFetchResult(result, globals.json);
    return 0;
  }

  const shouldUpdateInPlace = target !== ':memory:' && await Bun.file(target).exists();
  const resolver = new DneResolver(sourceInput, {
    onProgress: progress,
    remoteInfo: remoteInfo ?? undefined,
  });
  const scratch = await createScratchTarget(target);
  const writer = new DneDatabaseWriter(scratch.path, schema);
  let closed = false;
  let rowCount = 0;

  try {
    const source = await resolver.resolve(schema);
    progress(options.format === 'binary' ? 'Carregando a base binária' : 'Carregando a base SQLite');
    rowCount = await writer.loadFromSource(
      source,
      buildLoadMetadata(sourceInput, remoteInfo, VERSION),
      progress,
    );
    writer.close();
    closed = true;
    let outputPath = scratch.path;
    if (options.format === 'binary') {
      outputPath = `${scratch.path}.bin`;
      progress('Compactando a base binária');
      await buildBinaryDatabase(scratch.path, outputPath);
      await rm(scratch.path, { force: true });
    }
    progress(options.format === 'binary' ? 'Confirmando a base binária' : 'Confirmando a base SQLite');
    if (options.format === 'sqlite' && shouldUpdateInPlace) {
      await replaceTargetFromScratch(target, scratch.path, schema);
    } else {
      await scratch.commit(outputPath);
    }
    progress.finish();
  } finally {
    if (!closed) {
      writer.close();
    }
    await scratch.cleanup();
    await resolver.cleanup();
  }

  const inspection = target === ':memory:'
    ? memoryDatabaseInspection(rowCount)
    : await inspectDatabase(target);
  const result = {
    database: inspection,
    elapsed_ms: elapsedMilliseconds(startedAt),
    source: remoteSourceData(sourceInput, remoteInfo),
    status: shouldUpdateInPlace ? 'updated' : 'created',
  };
  writeFetchResult(result, globals.json);
  return 0;
}

async function lookupCep(options: LookupOptions, globals: GlobalOptions) {
  if (globals.json && options.jsonl) {
    throw new UserError('output-conflict', '--json e --jsonl não podem ser usados juntos.', EXIT_INVALID_INPUT);
  }

  const inputs = collectCepInputs(options.input, options.file);
  const iterator = inputs[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) {
    throw new UserError('missing-input', 'Informe um CEP, --file CAMINHO ou uma entrada em stdin.', EXIT_INVALID_INPUT);
  }

  const firstInput = { input: first.value, cep: normalizeCep(first.value) };
  const database = databasePath(globals.database);
  const reader = await openReadyDatabase(database);
  const results: LookupResult[] = [];
  let count = 0;
  let hasMissing = false;

  try {
    processInput(firstInput);
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      processInput({ input: next.value, cep: normalizeCep(next.value) });
    }
  } finally {
    reader.close();
  }

  if (globals.json) {
    writeJson({
      count,
      database,
      results,
    });
  } else if (!options.jsonl) {
    writeLookupText(results);
  }

  return hasMissing ? EXIT_NOT_FOUND : 0;

  function processInput(value: { cep: string; input: string; }) {
    const address = reader.queryCep(value.cep);
    const result = {
      address,
      cep: value.cep,
      found: address !== null,
      input: value.input,
    } satisfies LookupResult;
    count++;
    hasMissing ||= !result.found;
    if (options.jsonl) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: { database, result } })}\n`);
      return;
    }
    results.push(result);
  }
}

async function showStatus(globals: GlobalOptions) {
  const inspection = await inspectDatabase(databasePath(globals.database));
  if (globals.json) {
    writeJson(inspection);
  } else {
    writeStatusText(inspection);
  }
  return inspection.ready ? 0 : EXIT_FAILURE;
}

async function showSchema(options: { expected: boolean; }, globals: GlobalOptions) {
  const schema = buildDneSchema();
  const cepTable = getUnifiedTable(schema);

  let database: string | null = null;
  let source: 'binary' | 'database' | 'declared' = 'declared';
  let sql = createPrettyTableSql(cepTable);

  if (!options.expected) {
    database = databasePath(globals.database);
    const reader = await openReadyDatabase(database);
    try {
      if (!('tableSchema' in reader)) {
        source = 'binary';
      } else {
        const storedSchema = reader.tableSchema(SQLITE_CEP_TABLE_NAME);
        if (storedSchema) {
          sql = formatTableSql(storedSchema);
          source = 'database';
        }
      }
    } finally {
      reader.close();
    }
  }

  if (globals.json) {
    writeJson({ database, source, sql, table: SQLITE_CEP_TABLE_NAME });
  } else {
    console.log(renderSqlMarkdown(sql, globals.color));
  }
  return 0;
}

async function doctor(options: { offline: boolean; source: string; }, globals: GlobalOptions) {
  const inspection = await inspectDatabase(databasePath(globals.database));
  const runtimeCompatible = bunVersionIsCompatible(Bun.version);
  let source: Record<string, unknown> = {
    checked: false,
    reachable: null,
    url: options.source,
  };

  if (!options.offline) {
    try {
      const info = await inspectRemoteDneSource(options.source);
      source = {
        ...remoteSourceData(options.source, info),
        checked: true,
        reachable: true,
      };
    } catch (error) {
      source = {
        checked: true,
        error: humanErrorMessage(error),
        reachable: false,
        url: options.source,
      };
    }
  }

  const healthy = runtimeCompatible && inspection.ready && source['reachable'] !== false;
  const result = {
    auth: {
      required: false,
      source: 'not-required',
    },
    database: inspection,
    healthy,
    runtime: {
      compatible: runtimeCompatible,
      minimum_version: '1.4.0',
      name: 'bun',
      version: Bun.version,
    },
    setup: inspection.ready ? null : `Execute bunx @konstit/dne build --db ${shellQuote(inspection.path)}`,
    source,
    version: VERSION,
  };

  if (globals.json) {
    writeJson(result);
  } else {
    writeDoctorText(result);
  }
  return healthy ? 0 : EXIT_FAILURE;
}

async function querySql(options: { limit: number; query: string; }, globals: GlobalOptions) {
  if (!/^\s*(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(options.query)) {
    throw new UserError(
      'write-query-denied',
      'O comando sql permite somente instruções SELECT, WITH, PRAGMA e EXPLAIN.',
      EXIT_INVALID_INPUT,
    );
  }

  const database = databasePath(globals.database);
  const reader = await openReadyDatabase(database);
  try {
    if (!('querySql' in reader)) {
      throw new UserError('sql-unsupported', 'O comando sql exige uma base SQLite.', EXIT_INVALID_INPUT);
    }
    const result = reader.querySql(options.query, options.limit);
    const output = {
      columns: result.rows[0] ? Object.keys(result.rows[0]) : [],
      database,
      limit: options.limit,
      ...result,
    };
    if (globals.json) {
      writeJson(output);
    } else {
      console.log(JSON.stringify(output, null, 2));
    }
  } finally {
    reader.close();
  }
  return 0;
}

async function inspectRemoteSource(source: string, progress: (message: string) => void) {
  progress('Inspecionando a fonte DNE remota');
  try {
    return await inspectRemoteDneSource(source);
  } catch (error) {
    throw new UserError('source-unavailable', humanErrorMessage(error));
  }
}

function remoteSourceData(source: string, info: RemoteDneSourceInfo | null) {
  return info
    ? {
      accept_ranges: info.acceptRanges,
      content_length: info.contentLength,
      etag: info.etag,
      kind: 'remote',
      last_modified: info.lastModified,
      url: info.url,
    }
    : {
      input: source,
      kind: looksLikeUrl(source) ? 'remote' : 'local',
    };
}

function createProgress(quiet: boolean) {
  let messageStartedAt: number | null = null;

  const finish = () => {
    if (messageStartedAt !== null) {
      process.stderr.write(` (${formatDuration(elapsedMilliseconds(messageStartedAt))})\n`);
      messageStartedAt = null;
    }
  };

  const progress = ((message: string) => {
    finish();
    if (!quiet) {
      messageStartedAt = performance.now();
      process.stderr.write(message);
    }
  }) as ProgressReporter;
  progress.finish = finish;
  return progress;
}

function writeJson(data: unknown) {
  process.stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`);
}

function writeError(error: UserError, json: boolean) {
  if (json) {
    process.stderr.write(`${
      JSON.stringify({
        error: {
          code: error.code,
          ...(error.details ? { details: error.details } : {}),
          message: error.message,
        },
        ok: false,
      })
    }\n`);
    return;
  }
  console.error(`erro: ${error.message}`);
}

function reportFailure(error: unknown, json: boolean) {
  const failure = error instanceof UserError
    ? error
    : error instanceof DneSourceQualityError
    ? new UserError('source-quality-failed', humanErrorMessage(error))
    : new UserError('internal-error', humanErrorMessage(error));
  writeError(failure, json);
  return failure.exitCode;
}

function writeFetchCheck(result: {
  database: DatabaseInspection;
  source: Record<string, unknown>;
  status: string;
  up_to_date: boolean | null;
}, json: boolean) {
  if (json) {
    writeJson(result);
    return;
  }
  console.log(`Estado: ${fetchStatusText(result.status)}`);
  console.log(`Base: ${result.database.path}`);
  console.log(`Fonte: ${stringValue(result.source['url'] ?? result.source['input'])}`);
  console.log(`Última modificação na fonte: ${formatDateTime(stringValue(result.source['last_modified']))}`);
}

function writeFetchResult(result: {
  database: DatabaseInspection;
  elapsed_ms: number;
  source: Record<string, unknown>;
  status: string;
}, json: boolean) {
  if (json) {
    writeJson(result);
    return;
  }
  const rows = result.database.row_count === null
    ? 'quantidade desconhecida de registros'
    : `${formatInteger(result.database.row_count)} registros`;
  const size = result.database.size_bytes === null ? 'tamanho desconhecido' : formatBytes(result.database.size_bytes);
  if (result.status === 'unchanged') {
    const records = result.database.row_count === null
      ? 'quantidade desconhecida de registros'
      : `${formatInteger(result.database.row_count)} registros`;
    console.log(`A base DNE já está atualizada: ${result.database.path} (${records}, ${size}).`);
    console.log(`Última modificação na fonte: ${formatDateTime(stringValue(result.source['last_modified']))}`);
    console.log(`Verificação concluída em ${formatDuration(result.elapsed_ms)}.`);
    return;
  }
  const action = result.status === 'updated' ? 'Base atualizada' : 'Base criada';
  console.log(`${action}: ${result.database.path} (${rows}, ${size}, ${formatDuration(result.elapsed_ms)}).`);
}

function writeLookupText(results: LookupResult[]) {
  if (results.length === 1) {
    const result = results[0];
    if (!result?.address) {
      console.error(`CEP não encontrado: ${result?.cep ?? ''}`);
      return;
    }
    console.log(result.address);
    return;
  }

  console.log('cep\tencontrado\tlogradouro\tbairro\tmunicípio\tuf');
  for (const result of results) {
    console.log([
      result.cep,
      formatBoolean(result.found),
      result.address?.logradouro ?? '',
      result.address?.bairro ?? '',
      result.address?.municipio ?? '',
      result.address?.uf ?? '',
    ].join('\t'));
  }
}

function writeStatusText(inspection: DatabaseInspection) {
  console.log(`Base: ${inspection.path}`);
  console.log(`Formato: ${inspection.format ?? '-'}`);
  console.log(`Existe: ${formatBoolean(inspection.exists)}`);
  console.log(`Pronta: ${formatBoolean(inspection.ready)}`);
  console.log(`Registros: ${inspection.row_count === null ? '-' : formatInteger(inspection.row_count)}`);
  console.log(`Tamanho: ${inspection.size_bytes === null ? '-' : formatBytes(inspection.size_bytes)}`);
  console.log(`Carregada em: ${formatDateTime(inspection.metadata?.['loaded_at'])}`);
  console.log(`Pacote: @konstit/dne@${inspection.metadata?.['package_version'] ?? '-'}`);
  console.log(`Fonte: ${inspection.metadata?.['source_url'] ?? inspection.metadata?.['source_input'] ?? '-'}`);
  console.log(`Última modificação da fonte: ${formatDateTime(inspection.metadata?.['source_last_modified'])}`);
  if (inspection.error) {
    console.log(`Erro: ${inspection.error}`);
  }
}

function writeDoctorText(result: {
  database: DatabaseInspection;
  healthy: boolean;
  runtime: { compatible: boolean; name: string; version: string; };
  setup: string | null;
  source: Record<string, unknown>;
  version: string;
}) {
  console.log(`CLI: dne ${result.version}`);
  console.log(
    `Ambiente: ${result.runtime.name} ${result.runtime.version} (${result.runtime.compatible ? 'compatível' : 'não compatível'})`,
  );
  console.log(`Base: ${result.database.ready ? 'pronta' : 'configuração necessária'} (${result.database.path})`);
  console.log(
    `Fonte: ${result.source['reachable'] === null ? 'não verificada' : result.source['reachable'] ? 'acessível' : 'inacessível'}`,
  );
  console.log(`Saudável: ${formatBoolean(result.healthy)}`);
  if (result.setup) {
    console.log(`Configuração: ${result.setup}`);
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function humanErrorMessage(error: unknown) {
  return localizeRuntimeError(errorMessage(error));
}

function localizeRuntimeError(message: string) {
  const exactMessages: Record<string, string> = {
    'Failed to write downloaded content': 'Falha ao gravar o conteúdo baixado',
    'Invalid ZIP central directory entry': 'Entrada inválida no diretório central do ZIP',
    'Invalid ZIP central directory entry size': 'Tamanho inválido de entrada no diretório central do ZIP',
    'Invalid ZIP central directory range': 'Intervalo inválido do diretório central do ZIP',
    'Only sqlite:/// database URLs are supported': 'Somente URLs de base no formato sqlite:/// são aceitas',
    'package.json has no valid version': 'package.json não contém uma versão válida',
    'Source is not a valid ZIP file': 'A fonte não é um arquivo ZIP válido',
    'Unified schema table not found': 'Tabela unificada não encontrada no schema',
    'ZIP file does not contain DNE Basico files': 'O arquivo ZIP não contém arquivos do DNE Básico',
  };
  const exact = exactMessages[message];
  if (exact) {
    return exact;
  }

  return message
    .replace(/^Failed to download (.+): (\d+)$/, 'Falha ao baixar $1: $2')
    .replace(/^Failed to stream (.+): empty response body$/, 'Falha ao transmitir $1: corpo da resposta vazio')
    .replace(/^Failed to inspect DNE from (.+): (\d+)$/, 'Falha ao inspecionar o DNE em $1: $2')
    .replace(/^DNE source not found: (.+)$/, 'Fonte DNE não encontrada: $1')
    .replace(/^DNE source quality validation failed: (.+)$/, 'A validação de qualidade da fonte DNE falhou: $1')
    .replace(/^DNE data file not found: (.+)$/, 'Arquivo de dados DNE não encontrado: $1')
    .replace(/^Invalid ZIP local header for (.+)$/, 'Cabeçalho local ZIP inválido para $1')
    .replace(/^Invalid ZIP data range for (.+)$/, 'Intervalo de dados ZIP inválido para $1')
    .replace(/^Invalid decompressed size for (.+)$/, 'Tamanho descompactado inválido para $1')
    .replace(/^Unsupported ZIP compression method (\d+) for (.+)$/, 'Método de compactação ZIP $1 não aceito para $2')
    .replace(/^CRC32 mismatch for (.+)$/, 'CRC32 divergente para $1')
    .replace(/^Server ignored byte range (.+)$/, 'O servidor ignorou o intervalo de bytes $1')
    .replace(/^Server returned an invalid Content-Range for (.+)$/, 'O servidor retornou um Content-Range inválido para $1')
    .replace(
      /^Server returned (\d+) bytes for range (.+); expected (\d+)$/,
      'O servidor retornou $1 bytes para o intervalo $2; eram esperados $3',
    )
    .replace(/^Missing row at index (\d+)$/, 'Registro ausente no índice $1')
    .replace(/^Table with original name '(.+)' not found$/, 'Tabela com nome original \'$1\' não encontrada');
}

function localizeCliText(output: string) {
  return output
    .replaceAll('Usage:', 'Uso:')
    .replaceAll('Arguments:', 'Argumentos:')
    .replaceAll('Commands:', 'Comandos:')
    .replaceAll('Options:', 'Opções:')
    .replaceAll('Print help for a subcommand', 'Exibir ajuda de um subcomando')
    .replaceAll('Print help', 'Exibir ajuda')
    .replaceAll('Print version', 'Exibir versão')
    .replaceAll('Enable or disable color output', 'Ativar ou desativar cores na saída')
    .replaceAll('expected a schedulable Bun cron expression', 'esperada uma expressão cron válida')
    .replaceAll('[env:', '[variável:')
    .replaceAll('[default:', '[padrão:')
    .replaceAll('For more information, try \'--help\'.', 'Para mais informações, use \'--help\'.')
    .replaceAll('error:', 'erro:')
    .replace(/invalid value (.+?) for (.+?): expected value matching (.+)/g, 'valor inválido $1 para $2: esperado valor compatível com $3')
    .replace(
      /invalid value (.+?) for (.+?): expected a number from (.+?) to (.+)/g,
      'valor inválido $1 para $2: esperado número entre $3 e $4',
    )
    .replace(/invalid value (.+?) for (.+?): (.+)/g, 'valor inválido $1 para $2: $3')
    .replace(/unexpected argument (.+)/g, 'argumento inesperado $1')
    .replace(
      /arguments (.+?) and (.+?) cannot be used together/g,
      'os argumentos $1 e $2 não podem ser usados juntos',
    )
    .replace(
      /argument (.+?) requires at least (\d+) value\(s\)/g,
      'o argumento $1 exige pelo menos $2 valor(es)',
    )
    .replace(
      /the following required arguments were not provided:/g,
      'os seguintes argumentos obrigatórios não foram informados:',
    )
    .replace(/a similar argument exists:/g, 'existe um argumento semelhante:');
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function firstErrorLine(output: string) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^error:\s*/i, '') ?? 'Argumentos inválidos.';
}

function elapsedMilliseconds(startedAt: number) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function formatInteger(value: number) {
  return INTEGER_FORMAT.format(value);
}

function formatDecimal(value: number) {
  return DECIMAL_FORMAT.format(value);
}

function formatDateTime(value: string | undefined) {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(DISPLAY_LOCALE);
}

/**
 * Formats elapsed milliseconds for display using Brazilian Portuguese number formatting.
 * @param milliseconds - Elapsed time; negative values are clamped to zero.
 * @returns A compact duration in milliseconds, seconds, minutes, or hours.
 */
export function formatDuration(milliseconds: number) {
  const normalized = Math.max(0, Math.round(milliseconds));
  if (normalized < 1_000) {
    return `${formatInteger(normalized)} ms`;
  }

  const totalSeconds = Math.round(normalized / 1_000);
  if (totalSeconds < 60) {
    const seconds = Math.round(normalized / 100) / 10;
    return `${DURATION_SECONDS_FORMAT.format(seconds)} s`;
  }

  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [
    hours ? `${formatInteger(hours)} h` : '',
    minutes ? `${formatInteger(minutes)} min` : '',
    seconds ? `${formatInteger(seconds)} s` : '',
  ].filter(Boolean).join(' ');
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${formatInteger(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${formatDecimal(bytes / 1024)} KiB`;
  }
  return `${formatDecimal(bytes / (1024 * 1024))} MiB`;
}

function formatBoolean(value: boolean) {
  return value ? 'sim' : 'não';
}

function fetchStatusText(status: string) {
  const statuses: Record<string, string> = {
    'current': 'atualizada',
    'unknown': 'desconhecido',
    'update-available': 'atualização disponível',
  };
  return statuses[status] ?? status;
}

function shellQuote(value: string) {
  return `'${value.replaceAll('\'', '\'\\\'\'')}'`;
}

function bunVersionIsCompatible(version: string) {
  const [major = 0, minor = 0,] = version.split('.').map(Number);
  return major > 1 || (major === 1 && minor >= 4);
}

async function readPackageVersion() {
  const manifest = await Bun.file(new URL('../package.json', import.meta.url)).json() as { version?: unknown; };
  if (typeof manifest.version !== 'string' || !manifest.version) {
    throw new Error('package.json has no valid version');
  }
  return manifest.version;
}

function buildDneSchema() {
  const schema = buildSchema();
  getUnifiedTable(schema).name = SQLITE_CEP_TABLE_NAME;
  return schema;
}

async function replaceTargetFromScratch(
  targetPath: string,
  scratchPath: string,
  schema: ReturnType<typeof buildDneSchema>,
) {
  const cepTable = getUnifiedTable(schema);

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
      prepareTableForLoad(db, cepTable);
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
  database: string,
  format: DatabaseFormat,
  remoteInfo: RemoteDneSourceInfo,
) {
  const inspection = await inspectDatabase(database);
  if (!inspection.ready || inspection.format !== format || !inspection.metadata) {
    return false;
  }
  return remoteMetadataMatches(inspection.metadata, remoteInfo);
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

function formatTableSql(sql: string) {
  const openingParenthesis = sql.indexOf('(');
  const closingParenthesis = sql.lastIndexOf(')');
  if (openingParenthesis === -1 || closingParenthesis <= openingParenthesis) {
    return sql;
  }

  const definitions = splitTopLevelSqlList(
    sql.slice(openingParenthesis + 1, closingParenthesis),
  );
  if (!definitions.length) {
    return sql;
  }

  const prefix = sql.slice(0, openingParenthesis + 1).trimEnd();
  const suffix = sql.slice(closingParenthesis).trimStart();
  return `${prefix}\n  ${definitions.join(',\n  ')}\n${suffix}`;
}

function splitTopLevelSqlList(sql: string) {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: '\'' | '"' | '`' | ']' | null = null;
  let comment: 'block' | 'line' | null = null;

  for (let index = 0; index < sql.length; index++) {
    const character = sql[index];

    if (comment === 'line') {
      if (character === '\n' || character === '\r') {
        comment = null;
      }
      continue;
    }
    if (comment === 'block') {
      if (character === '*' && sql[index + 1] === '/') {
        comment = null;
        index++;
      }
      continue;
    }

    if (quote) {
      if (character === quote) {
        if (sql[index + 1] === quote) {
          index++;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (character === '-' && sql[index + 1] === '-') {
      comment = 'line';
      index++;
    } else if (character === '/' && sql[index + 1] === '*') {
      comment = 'block';
      index++;
    } else if (character === '\'' || character === '"' || character === '`') {
      quote = character;
    } else if (character === '[') {
      quote = ']';
    } else if (character === '(') {
      depth++;
    } else if (character === ')') {
      depth--;
    } else if (character === ',' && depth === 0) {
      parts.push(sql.slice(start, index).trim());
      start = index + 1;
    }
  }

  parts.push(sql.slice(start).trim());
  return parts.filter(Boolean);
}

function renderSqlMarkdown(sql: string, color: boolean) {
  return Bun.markdown.render(`\`\`\`sql\n${sql}\n\`\`\``, {
    code: (children) => renderSqlCodeBlock(children, color),
  }).trimEnd();
}

/**
 * Applies terminal syntax highlighting to SQL while preserving quoted strings and comments.
 * @param sql - SQL text to render.
 * @param color - Whether ANSI color sequences should be emitted.
 * @returns The original text when color is disabled, or a highlighted string.
 */
export function renderSqlCodeBlock(sql: string, color: boolean) {
  if (!color) {
    return sql;
  }

  return sql.replaceAll(SQL_HIGHLIGHT_PATTERN, (token) => {
    if (token.startsWith('--') || token.startsWith('/*')) {
      return `${ANSI_GRAY}${token}${ANSI_RESET}`;
    }
    if (token.startsWith('"') || token.startsWith('`') || token.startsWith('[')) {
      return `${ANSI_CYAN}${token}${ANSI_RESET}`;
    }
    if (token.startsWith('\'')) {
      return token;
    }
    return `${ANSI_BOLD}${token}${ANSI_RESET}`;
  });
}

async function createScratchTarget(target: string) {
  if (target === ':memory:') {
    return {
      path: target,
      commit: async (_sourcePath?: string) => {},
      cleanup: async () => {},
    };
  }

  const directory = dirname(target);
  const scratch = join(
    directory,
    `.${basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  await mkdir(directory, { recursive: true });
  await rm(scratch, { force: true });

  let committed = false;
  return {
    path: scratch,
    commit: async (sourcePath = scratch) => {
      await rename(sourcePath, target);
      committed = true;
    },
    cleanup: async () => {
      if (!committed) {
        await rm(scratch, { force: true });
      }
      await rm(`${scratch}.bin`, { force: true });
      await rm(`${scratch}-journal`, { force: true });
    },
  };
}
