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
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  copyFile,
  mkdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import {
  homedir,
  tmpdir,
} from 'node:os';
import {
  basename,
  dirname,
  join,
  resolve,
} from 'node:path';
import {
  createPrettyTableSql,
  createTableSql,
  DneDatabaseReader,
  DneDatabaseWriter,
  hasTable,
  quoteIdent,
  readDatabaseMetadata,
  sqlitePathFromDatabaseUrl,
  type DneRow,
  type LoadMetadata,
} from './db.ts';
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

const REMOTE_LAST_MODIFIED_TOLERANCE_MS = 10 * 60 * 1000;
const DEFAULT_CRON_EXPRESSION = '0 0 * * 5';
const FETCH_LOCK_TIMEOUT_MS = 30_000;
const FETCH_LOCK_RETRY_MS = 50;
const FETCH_LOCK_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;
const CEP_PATTERN = /^(?:\d{8}|\d{5}-\d{3})$/;
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
  describe: 'Caminho da base SQLite.',
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

export const cli = command(BINARY_NAME, {
  about: 'Criar e consultar uma base SQLite local com os CEPs do Brasil.',
  afterHelp: [
    'Exemplos:',
    '  bunx @konstit/dne build --db ./dne.db',
    '  bunx @konstit/dne get 01001-000 --db ./dne.db',
    '  bunx @konstit/dne status --db ./dne.db',
    '  bunx @konstit/dne cron install --db ./dne.db',
  ].join('\n'),
  args: [databaseArgument, jsonArgument, quietArgument, colorArgument],
  version: VERSION,
  subcommands: [
    command('build', {
      args: [
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
      about: 'Criar ou atualizar a base SQLite',
      conflicts: [['force', 'check']],
      handler: (args, context) => fetchDatabase(args, globalOptions(context)),
    }),
    command('get', {
      args: [
        positional('input', parsers.regex(CEP_PATTERN), {
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
  source: string;
};

type LookupOptions = {
  file: string | undefined;
  input: readonly string[];
  jsonl: boolean;
};

type CronEntry = {
  command: string;
  database: string;
  expression: string;
  id: string;
  package_version: string;
  runner: string;
  title: string;
};

type ProgressReporter = {
  (message: string): void;
  finish(): void;
};

type DatabaseInspection = {
  error?: string;
  exists: boolean;
  metadata: LoadMetadata | null;
  path: string;
  ready: boolean;
  row_count: number | null;
  schema: string | null;
  size_bytes: number | null;
};

type LookupResult = {
  address: DneRow | null;
  cep: string;
  found: boolean;
  input: string;
};

class UserError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = EXIT_FAILURE,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'UserError';
  }
}

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
  options: { 'dry-run': boolean; 'expression': string; },
  globals: GlobalOptions,
) {
  const database = cronDatabasePath(globals.database);
  const entry = createCronEntry(options.expression, database);
  const previous = readCronEntry(database);
  const status = options['dry-run'] ? 'preview' : previous ? 'updated' : 'installed';

  if (!options['dry-run']) {
    await registerCronEntry(entry, previous);
  }

  const result = { ...entry, next_run: nextCronRun(entry.expression), status };
  if (globals.json) {
    writeJson(result);
  } else {
    const action = status === 'preview'
      ? 'Agendamento que seria instalado'
      : status === 'updated'
      ? 'Agendamento atualizado'
      : 'Agendamento instalado';
    console.log(`${action}: ${entry.expression}`);
    console.log(`Próxima execução: ${formatDateTime(result.next_run ?? undefined)}`);
    console.log(`Base: ${entry.database}`);
    console.log(`Comando: ${entry.command}`);
  }
  return 0;
}

function showCronStatus(globals: GlobalOptions) {
  const database = cronDatabasePath(globals.database);
  const title = cronTitle(database);
  const entry = readCronEntry(database);
  const result = {
    command: entry?.command ?? null,
    database,
    expression: entry?.expression ?? null,
    id: title,
    installed: entry !== null,
    next_run: entry ? nextCronRun(entry.expression) : null,
    package_version: entry?.package_version ?? null,
    runner: entry?.runner ?? null,
    title,
  };

  if (globals.json) {
    writeJson(result);
  } else if (entry) {
    console.log(`Agendamento instalado: ${entry.expression}`);
    console.log(`Próxima execução: ${formatDateTime(result.next_run ?? undefined)}`);
    console.log(`Base: ${entry.database}`);
    console.log(`Pacote: @konstit/dne@${entry.package_version}`);
    console.log(`Comando: ${entry.command}`);
  } else {
    console.log(`Nenhum agendamento instalado para a base: ${database}`);
  }
  return 0;
}

async function removeCron(globals: GlobalOptions) {
  const database = cronDatabasePath(globals.database);
  const paths = cronEntryPaths(database);
  const removed = pathExists(paths.metadata) || pathExists(paths.runner);
  try {
    await Bun.cron.remove(paths.title);
  } catch (error) {
    throw new UserError(
      'cron-remove-failed',
      `Não foi possível remover o agendamento: ${humanErrorMessage(error)}`,
    );
  }
  rmSync(paths.metadata, { force: true });
  rmSync(paths.runner, { force: true });

  const output = { database, id: paths.title, removed, title: paths.title };
  if (globals.json) {
    writeJson(output);
  } else if (removed) {
    console.log(`Agendamento removido para a base: ${database}`);
  } else {
    console.log(`Nenhum agendamento instalado para a base: ${database}`);
  }
  return 0;
}

function createCronEntry(expression: string, database: string): CronEntry {
  const bunx = Bun.which('bunx');
  if (!bunx) {
    throw new UserError(
      'bunx-not-found',
      'O executável bunx não foi encontrado. Instale o Bun antes de criar o agendamento.',
    );
  }
  if (/[\r\n\0]/.test(expression) || /[\r\n\0]/.test(bunx)) {
    throw new UserError(
      'invalid-cron-value',
      'A expressão cron e o caminho do bunx não podem conter quebras de linha ou bytes nulos.',
      EXIT_INVALID_INPUT,
    );
  }

  const paths = cronEntryPaths(database);
  const bunxPath = resolve(bunx);
  const packageSpec = `@konstit/dne@${VERSION}`;
  return {
    command: [
      shellQuote(bunxPath),
      shellQuote(packageSpec),
      'build',
      '--db',
      shellQuote(database),
      '--quiet',
    ].join(' '),
    database,
    expression,
    id: paths.title,
    package_version: VERSION,
    runner: paths.runner,
    title: paths.title,
  };
}

async function registerCronEntry(entry: CronEntry, previous: CronEntry | null) {
  const paths = cronEntryPaths(entry.database);
  mkdirSync(paths.directory, { mode: 0o700, recursive: true });
  const previousRunner = readOptionalFile(paths.runner);
  const previousMetadata = readOptionalFile(paths.metadata);
  try {
    writePrivateFile(paths.runner, createCronRunnerSource(entry));
    await Bun.cron(paths.runner, entry.expression, entry.title);
    writePrivateFile(paths.metadata, `${JSON.stringify(entry, null, 2)}\n`);
  } catch (error) {
    restoreOptionalFile(paths.runner, previousRunner);
    restoreOptionalFile(paths.metadata, previousMetadata);
    try {
      if (previous) {
        await Bun.cron(previous.runner, previous.expression, previous.title);
      } else {
        await Bun.cron.remove(entry.title);
      }
    } catch {
      // Preserve the original registration error.
    }
    throw new UserError(
      'cron-install-failed',
      `Não foi possível instalar o agendamento: ${humanErrorMessage(error)}`,
    );
  }
}

function createCronRunnerSource(entry: CronEntry) {
  const command = [
    Bun.which('bunx'),
    `@konstit/dne@${entry.package_version}`,
    'build',
    '--db',
    entry.database,
    '--quiet',
  ];
  if (command[0] === null) {
    throw new UserError('bunx-not-found', 'O executável bunx não foi encontrado.');
  }
  return [
    `const command = ${JSON.stringify(command)};`,
    '',
    'export default {',
    '  async scheduled() {',
    '    const child = Bun.spawn(command, { stderr: \'inherit\', stdout: \'ignore\' });',
    '    const exitCode = await child.exited;',
    '    if (exitCode !== 0) {',
    '      throw new Error(\'@konstit/dne build failed with exit code \' + exitCode);',
    '    }',
    '  },',
    '};',
    '',
  ].join('\n');
}

function cronDatabasePath(value: string) {
  const database = databasePath(value);
  if (database === ':memory:') {
    throw new UserError(
      'invalid-cron-database',
      'O agendamento exige um caminho persistente para a base.',
      EXIT_INVALID_INPUT,
    );
  }
  if (/[\r\n\0]/.test(database)) {
    throw new UserError(
      'invalid-cron-database',
      'O caminho da base não pode conter quebras de linha ou bytes nulos.',
      EXIT_INVALID_INPUT,
    );
  }
  return database;
}

function cronTitle(database: string) {
  const hash = new Bun.CryptoHasher('sha256').update(database).digest('hex').slice(0, 32);
  return `konstit-dne-${hash}`;
}

function cronEntryPaths(database: string) {
  const title = cronTitle(database);
  const stateHome = Bun.env['XDG_STATE_HOME']
    ? resolve(Bun.env['XDG_STATE_HOME'])
    : process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support')
    : join(homedir(), '.local', 'state');
  const directory = join(stateHome, 'konstit-dne', 'cron');
  return {
    directory,
    metadata: join(directory, `${title}.json`),
    runner: join(directory, `${title}.mjs`),
    title,
  };
}

function readCronEntry(database: string): CronEntry | null {
  const paths = cronEntryPaths(database);
  if (!pathExists(paths.metadata) && !pathExists(paths.runner)) {
    return null;
  }
  if (!pathExists(paths.metadata) || !pathExists(paths.runner)) {
    throw new UserError(
      'cron-config-invalid',
      `A configuração do agendamento '${paths.title}' está incompleta.`,
    );
  }
  try {
    const value = JSON.parse(readFileSync(paths.metadata, 'utf8')) as Partial<CronEntry>;
    if (
      value.database !== database
      || value.id !== paths.title
      || value.title !== paths.title
      || value.runner !== paths.runner
      || typeof value.command !== 'string'
      || typeof value.expression !== 'string'
      || typeof value.package_version !== 'string'
    ) {
      throw new Error('invalid cron metadata');
    }
    Bun.cron.parse(value.expression);
    return value as CronEntry;
  } catch {
    throw new UserError(
      'cron-config-invalid',
      `A configuração do agendamento '${paths.title}' é inválida.`,
    );
  }
}

function nextCronRun(expression: string) {
  return Bun.cron.parse(expression)?.toISOString() ?? null;
}

function writePrivateFile(path: string, content: string) {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readOptionalFile(path: string) {
  return pathExists(path) ? readFileSync(path, 'utf8') : null;
}

function restoreOptionalFile(path: string, content: string | null) {
  if (content === null) {
    rmSync(path, { force: true });
  } else {
    writePrivateFile(path, content);
  }
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
  const target = databasePath(globals.database);

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
    const inspection = await inspectDatabase(target);
    const upToDate = remoteInfo && inspection.ready
      ? await databaseIsCurrent(target, SQLITE_CEP_TABLE_NAME, remoteInfo)
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
    && (await databaseIsCurrent(target, SQLITE_CEP_TABLE_NAME, remoteInfo))
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
    progress('Carregando a base SQLite');
    rowCount = await writer.loadFromSource(
      source,
      buildLoadMetadata(sourceInput, remoteInfo),
      progress,
    );
    writer.close();
    closed = true;
    progress('Confirmando a base SQLite');
    if (shouldUpdateInPlace) {
      await replaceTargetFromScratch(target, scratch.path, schema);
    } else {
      await scratch.commit();
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

async function acquireFetchLock(target: string, progress: ProgressReporter) {
  const path = temporaryFetchLockPath(target);
  const obsoletePath = join(dirname(target), `.${basename(target)}.fetch.lock`);
  const owner = { pid: process.pid, token: crypto.randomUUID() };
  const deadline = performance.now() + FETCH_LOCK_TIMEOUT_MS;
  let waiting = false;

  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });

  while (pathExists(obsoletePath)) {
    if (recoverStaleFetchLock(obsoletePath)) {
      continue;
    }
    await waitForFetchLock();
  }
  while (!tryCreateFetchLock(path, owner)) {
    if (recoverStaleFetchLock(path)) {
      continue;
    }
    await waitForFetchLock();
  }

  if (waiting) {
    progress.finish();
  }

  let released = false;
  let removeProcessHandlers = () => {};
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    removeProcessHandlers();
    removeOwnedFetchLock(path, owner.token);
  };
  removeProcessHandlers = installFetchLockProcessHandlers(release);

  return { release };

  async function waitForFetchLock() {
    if (!waiting) {
      progress('Aguardando outra atualização da base');
      waiting = true;
    }
    if (performance.now() >= deadline) {
      throw new UserError(
        'update-in-progress',
        `Outra execução de build já está atualizando a base '${target}'.`,
      );
    }
    await Bun.sleep(FETCH_LOCK_RETRY_MS);
  }
}

type FetchLockOwner = {
  pid: number;
  token: string;
};

function temporaryFetchLockPath(target: string) {
  const targetHash = new Bun.CryptoHasher('sha256').update(target).digest('hex');
  return join(tmpdir(), `konstit-dne-${process.getuid?.() ?? 'unknown'}`, `fetch-${targetHash}.lock`);
}

function pathExists(path: string) {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if (isMissingPath(error)) {
      return false;
    }
    throw error;
  }
}

function tryCreateFetchLock(path: string, owner: FetchLockOwner) {
  const candidate = `${path}.${owner.pid}.${owner.token}.tmp`;
  mkdirSync(candidate);
  try {
    writeFileSync(join(candidate, 'owner.json'), JSON.stringify(owner), { flag: 'wx' });
    renameSync(candidate, path);
    return true;
  } catch (error) {
    if (isPathConflict(error)) {
      return false;
    }
    throw error;
  } finally {
    rmSync(candidate, { force: true, recursive: true });
  }
}

function recoverStaleFetchLock(path: string) {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch (error) {
    if (isMissingPath(error)) {
      return true;
    }
    throw error;
  }

  if (!stats.isDirectory()) {
    return removeLegacyFetchLock(path);
  }

  const owner = readFetchLockOwner(path);
  if (owner && processIsRunning(owner.pid)) {
    return false;
  }

  try {
    writeFileSync(
      join(path, 'reaper.json'),
      JSON.stringify({ pid: process.pid, token: crypto.randomUUID() }),
      { flag: 'wx' },
    );
  } catch (error) {
    if (isPathConflict(error)) {
      return false;
    }
    if (isMissingPath(error)) {
      return true;
    }
    throw error;
  }

  rmSync(path, { force: true, recursive: true });
  return true;
}

function removeLegacyFetchLock(path: string) {
  const database = new Database(path);
  try {
    database.run('PRAGMA busy_timeout = 0');
    database.run('BEGIN IMMEDIATE');
    database.run('ROLLBACK');
  } catch (error) {
    if (isSqliteLockConflict(error)) {
      return false;
    }
    throw error;
  } finally {
    database.close();
  }
  try {
    rmSync(path, { force: true });
    return true;
  } catch (error) {
    if (isMissingPath(error)) {
      return true;
    }
    if (isPathConflict(error)) {
      return false;
    }
    try {
      if (statSync(path).isDirectory()) {
        return false;
      }
    } catch (statError) {
      if (isMissingPath(statError)) {
        return true;
      }
      throw statError;
    }
    throw error;
  }
}

function readFetchLockOwner(path: string): FetchLockOwner | null {
  try {
    const value = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')) as Partial<FetchLockOwner>;
    return Number.isInteger(value.pid) && Number(value.pid) > 0 && typeof value.token === 'string'
      ? { pid: Number(value.pid), token: value.token }
      : null;
  } catch {
    return null;
  }
}

function processIsRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'ESRCH'
    );
  }
}

function removeOwnedFetchLock(path: string, token: string) {
  if (readFetchLockOwner(path)?.token === token) {
    rmSync(path, { force: true, recursive: true });
  }
}

function installFetchLockProcessHandlers(release: () => void) {
  const exitHandler = () => release();
  const signalHandlers = FETCH_LOCK_SIGNALS.map((signal) => {
    const handler = () => {
      release();
      process.kill(process.pid, signal);
    };
    process.once(signal, handler);
    return { handler, signal };
  });
  process.once('exit', exitHandler);

  return () => {
    process.off('exit', exitHandler);
    for (const { handler, signal } of signalHandlers) {
      process.off(signal, handler);
    }
  };
}

async function lookupCep(options: LookupOptions, globals: GlobalOptions) {
  if (globals.json && options.jsonl) {
    throw new UserError('output-conflict', '--json e --jsonl não podem ser usados juntos.', EXIT_INVALID_INPUT);
  }

  const inputs = await collectCepInputs(options.input, options.file);
  if (!inputs.length) {
    throw new UserError('missing-input', 'Informe um CEP, --file CAMINHO ou uma entrada em stdin.', EXIT_INVALID_INPUT);
  }

  const normalized = inputs.map((input) => ({ input, cep: normalizeCep(input) }));
  const database = databasePath(globals.database);
  const reader = await openReadyDatabase(database);
  const results: LookupResult[] = [];

  try {
    for (const value of normalized) {
      const address = reader.queryCep(SQLITE_CEP_TABLE_NAME, value.cep);
      results.push({
        address,
        cep: value.cep,
        found: address !== null,
        input: value.input,
      });
    }
  } finally {
    reader.close();
  }

  if (options.jsonl) {
    for (const result of results) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: { database, result } })}\n`);
    }
  } else if (globals.json) {
    writeJson({
      count: results.length,
      database,
      results,
    });
  } else {
    writeLookupText(results);
  }

  return results.some((result) => !result.found) ? EXIT_NOT_FOUND : 0;
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
  let source: 'database' | 'declared' = 'declared';
  let sql = createPrettyTableSql(cepTable);

  if (!options.expected) {
    database = databasePath(globals.database);
    const reader = await openReadyDatabase(database);
    try {
      sql = reader.tableSchema(SQLITE_CEP_TABLE_NAME)
        ?? (() => {
          throw new UserError('schema-not-found', `A tabela '${SQLITE_CEP_TABLE_NAME}' não possui um esquema armazenado.`);
        })();
      sql = formatTableSql(sql);
      source = 'database';
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

  const healthy = runtimeCompatible && source['reachable'] !== false;
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

async function collectCepInputs(inputs: readonly string[], file: string | undefined) {
  const values = [...inputs];
  if (file) {
    const content = file === '-'
      ? await Bun.stdin.text()
      : await readInputFile(file);
    values.push(...splitCepInput(content));
  } else if (!values.length && !process.stdin.isTTY) {
    values.push(...splitCepInput(await Bun.stdin.text()));
  }
  return values;
}

async function readInputFile(path: string) {
  if (!(await Bun.file(path).exists())) {
    throw new UserError('input-file-not-found', `Arquivo de entrada com CEPs não encontrado: ${path}`);
  }
  return await Bun.file(path).text();
}

function splitCepInput(content: string) {
  return content
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function normalizeCep(value: string) {
  const trimmed = value.trim();
  if (!CEP_PATTERN.test(trimmed)) {
    throw new UserError(
      'invalid-cep',
      `CEP inválido '${value}'. Use 01001000 ou 01001-000.`,
      EXIT_INVALID_INPUT,
      { input: value },
    );
  }
  return trimmed.replace('-', '');
}

async function openReadyDatabase(path: string) {
  if (path === ':memory:' || !(await Bun.file(path).exists())) {
    throw new UserError('database-not-found', `Base não encontrada: ${path}`);
  }

  let reader: DneDatabaseReader;
  try {
    reader = new DneDatabaseReader(path);
  } catch (error) {
    throw new UserError('database-invalid', `Não foi possível abrir a base '${path}': ${humanErrorMessage(error)}`);
  }

  if (!reader.hasTable(SQLITE_CEP_TABLE_NAME)) {
    reader.close();
    throw new UserError(
      'database-not-ready',
      `A base '${path}' não contém a tabela '${SQLITE_CEP_TABLE_NAME}'. Execute bunx @konstit/dne build primeiro.`,
    );
  }
  return reader;
}

async function inspectDatabase(path: string): Promise<DatabaseInspection> {
  if (path === ':memory:' || !(await Bun.file(path).exists())) {
    return {
      exists: false,
      metadata: null,
      path,
      ready: false,
      row_count: null,
      schema: null,
      size_bytes: null,
    };
  }

  let size: number | null = null;
  try {
    size = (await stat(path)).size;
  } catch {
    // SQLite will provide the useful open error below.
  }

  try {
    const reader = new DneDatabaseReader(path);
    try {
      const ready = reader.hasTable(SQLITE_CEP_TABLE_NAME);
      return {
        exists: true,
        metadata: reader.metadata(),
        path,
        ready,
        row_count: ready ? reader.rowCount(SQLITE_CEP_TABLE_NAME) : null,
        schema: ready ? reader.tableSchema(SQLITE_CEP_TABLE_NAME) : null,
        size_bytes: size,
      };
    } finally {
      reader.close();
    }
  } catch (error) {
    return {
      error: humanErrorMessage(error),
      exists: true,
      metadata: null,
      path,
      ready: false,
      row_count: null,
      schema: null,
      size_bytes: size,
    };
  }
}

function memoryDatabaseInspection(rowCount: number): DatabaseInspection {
  return {
    exists: false,
    metadata: null,
    path: ':memory:',
    ready: false,
    row_count: rowCount,
    schema: null,
    size_bytes: null,
  };
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

function databasePath(value: string) {
  const path = sqlitePathFromDatabaseUrl(value);
  return path === ':memory:' ? path : resolve(path);
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

function isPathConflict(error: unknown) {
  return errorHasCode(error, 'EEXIST', 'EISDIR', 'ENOTEMPTY');
}

function isMissingPath(error: unknown) {
  return errorHasCode(error, 'ENOENT');
}

function errorHasCode(error: unknown, ...codes: string[]) {
  return Boolean(
    error
      && typeof error === 'object'
      && 'code' in error
      && codes.includes(String(error.code)),
  );
}

function isSqliteLockConflict(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : '';
  return code === 'SQLITE_BUSY'
    || code.startsWith('SQLITE_BUSY_')
    || code === 'SQLITE_LOCKED'
    || code.startsWith('SQLITE_LOCKED_')
    || /database is (?:busy|locked)/i.test(errorMessage(error));
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
  database: string,
  cepTableName: string,
  remoteInfo: RemoteDneSourceInfo,
) {
  if (!(await hasTable(database, cepTableName))) {
    return false;
  }

  const metadata = await readDatabaseMetadata(database);
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

  return Math.abs(previousTime - currentTime) <= REMOTE_LAST_MODIFIED_TOLERANCE_MS;
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
    package_version: VERSION,
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
      commit: async () => {},
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
    commit: async () => {
      await rename(scratch, target);
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
