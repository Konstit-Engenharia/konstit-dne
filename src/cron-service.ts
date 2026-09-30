import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { databasePath } from './database-service.ts';
import { UserError } from './errors.ts';
import { EDNE_DOWNLOAD_URL } from './settings.ts';

/**
 * Persisted configuration of one database-update schedule registered through Bun.cron.
 */
export type CronEntry = {
  /**
   * Shell-quoted command executed by the generated runner.
   */
  command: string;
  /** Local database path identifying the schedule. */
  database: string;
  /** Cron expression interpreted by Bun.cron. */
  expression: string;
  /**
   * Stable schedule identifier derived from the absolute database path.
   */
  id: string;
  /**
   * Package version pinned in the scheduled command.
   */
  package_version: string;
  /**
   * Absolute path to the generated runner script.
   */
  runner: string;
  /**
   * Source URL or absolute local source path stored for future runs.
   */
  source: string;
  /**
   * Bun.cron title, equal to the stable schedule identifier.
   */
  title: string;
};

/**
 * Inputs for installing, updating, or previewing a database-update schedule.
 */
type InstallCronOptions = {
  /** Local database path identifying the schedule. */
  database: string;
  /**
   * Returns a preview without registering a job or writing its state files.
   */
  dryRun: boolean;
  /** Cron expression interpreted by Bun.cron. */
  expression: string;
  /**
   * Package version to pin in the scheduled command.
   */
  packageVersion: string;
  /**
   * Optional source override; omission retains the existing source or uses the configured default.
   */
  source?: string;
};

/**
 * Installs or updates the schedule for one database, or computes a preview.
 * @param options - Database path, cron expression, package version, and optional source.
 * @returns The schedule configuration, status, and next run time.
 * @throws {UserError} If configuration or job registration fails. File-system errors may also propagate.
 */
export async function installCronSchedule(options: InstallCronOptions) {
  const database = cronDatabasePath(options.database);
  const previous = readCronEntry(database);
  const source = cronSource(options.source ?? previous?.source ?? EDNE_DOWNLOAD_URL);
  const entry = createCronEntry(options.expression, database, source, options.packageVersion);
  const status = options.dryRun ? 'preview' : previous ? 'updated' : 'installed';

  if (!options.dryRun) {
    await registerCronEntry(entry, previous);
  }

  return { ...entry, next_run: nextCronRun(entry.expression), status };
}

/**
 * Reads the stored schedule associated with a database path.
 * @param databaseInput - Local database path or supported SQLite URL.
 * @returns Installed-state details and the next run time; absent schedule fields are null.
 * @throws {UserError} If the path or stored configuration is invalid.
 */
export function showCronSchedule(databaseInput: string) {
  const database = cronDatabasePath(databaseInput);
  const title = cronTitle(database);
  const entry = readCronEntry(database);
  return {
    command: entry?.command ?? null,
    database,
    expression: entry?.expression ?? null,
    id: title,
    installed: entry !== null,
    next_run: entry ? nextCronRun(entry.expression) : null,
    package_version: entry?.package_version ?? null,
    runner: entry?.runner ?? null,
    source: entry?.source ?? null,
    title,
  };
}

/**
 * Removes a database-update schedule and its generated local state files.
 * @param databaseInput - Local database path or supported SQLite URL identifying the schedule.
 * @returns The schedule identifier and whether local schedule state existed.
 * @throws {UserError} If the database path is invalid or Bun.cron removal fails. File-system errors may also propagate.
 */
export async function removeCronSchedule(databaseInput: string) {
  const database = cronDatabasePath(databaseInput);
  const paths = cronEntryPaths(database);
  const removed = pathExists(paths.metadata) || pathExists(paths.runner);
  try {
    await Bun.cron.remove(paths.title);
  } catch (error) {
    throw new UserError(
      'cron-remove-failed',
      `Não foi possível remover o agendamento: ${errorMessage(error)}`,
    );
  }
  rmSync(paths.metadata, { force: true });
  rmSync(paths.runner, { force: true });
  return { database, id: paths.title, removed, title: paths.title };
}

function createCronEntry(
  expression: string,
  database: string,
  source: string,
  packageVersion: string,
): CronEntry {
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
      2,
    );
  }

  const paths = cronEntryPaths(database);
  const bunxPath = resolve(bunx);
  const packageSpec = `@konstit/dne@${packageVersion}`;
  return {
    command: [
      shellQuote(bunxPath),
      shellQuote(packageSpec),
      'build',
      '--db',
      shellQuote(database),
      '--source',
      shellQuote(source),
      '--quiet',
    ].join(' '),
    database,
    expression,
    id: paths.title,
    package_version: packageVersion,
    runner: paths.runner,
    source,
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
      `Não foi possível instalar o agendamento: ${errorMessage(error)}`,
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
    '--source',
    entry.source,
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
      2,
    );
  }
  if (/[\r\n\0]/.test(database)) {
    throw new UserError(
      'invalid-cron-database',
      'O caminho da base não pode conter quebras de linha ou bytes nulos.',
      2,
    );
  }
  return database;
}

function cronSource(value: string) {
  if (/[\r\n\0]/.test(value)) {
    throw new UserError(
      'invalid-cron-source',
      'A fonte não pode conter quebras de linha ou bytes nulos.',
      2,
    );
  }
  return looksLikeUrl(value) ? value : resolve(value);
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
    return {
      ...value,
      source: typeof value.source === 'string' ? value.source : EDNE_DOWNLOAD_URL,
    } as CronEntry;
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

function pathExists(path: string) {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

function shellQuote(value: string) {
  return `'${value.replaceAll('\'', '\'\\\'\'')}'`;
}

function looksLikeUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
