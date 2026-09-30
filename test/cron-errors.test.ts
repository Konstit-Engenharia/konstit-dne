import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  homedir,
  tmpdir,
} from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import {
  installCronSchedule,
  removeCronSchedule,
  showCronSchedule,
} from '../src/cron-service.ts';
import { EDNE_DOWNLOAD_URL } from '../src/settings.ts';
import { captureRejection } from './assertions.ts';

const directory = mkdtempSync(join(tmpdir(), 'dne-cron-errors-'));
const originalCron = Bun.cron;
const originalStateHome = Bun.env['XDG_STATE_HOME'];
const calls: string[] = [];
const options = {
  database: join(directory, 'scheduled.db'),
  dryRun: false,
  expression: '0 0 * * 5',
  packageVersion: '1.2.3',
};

beforeEach(() => {
  calls.length = 0;
  Bun.env['XDG_STATE_HOME'] = mkdtempSync(join(directory, 'state-'));
  const cron = Object.assign(
    mock(async () => {
      calls.push('install');
    }),
    {
      parse: originalCron.parse.bind(originalCron),
      remove: mock(async () => {
        calls.push('remove');
      }),
    },
  );
  Object.assign(Bun, { cron });
});

afterEach(() => {
  mock.restore();
  Object.assign(Bun, { cron: originalCron });
  if (originalStateHome === undefined) {
    delete Bun.env['XDG_STATE_HOME'];
  } else {
    Bun.env['XDG_STATE_HOME'] = originalStateHome;
  }
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('cron failure handling', () => {
  test.each([':memory:', 'invalid\npath', 'invalid\0path'])('rejects database path %p', (database) => {
    expect(() => showCronSchedule(database)).toThrow(expect.objectContaining({ code: 'invalid-cron-database' }));
  });

  test('rejects control characters in the source and cron expression', async () => {
    expect(await captureRejection(installCronSchedule({ ...options, source: 'invalid\nsource' }))).toMatchObject({
      code: 'invalid-cron-source',
    });
    expect(await captureRejection(installCronSchedule({ ...options, expression: '0 0 * * 5\n' }))).toMatchObject({
      code: 'invalid-cron-value',
    });
    expect(calls).toEqual([]);
  });

  test('reports missing or invalid bunx executables', async () => {
    const which = spyOn(Bun, 'which').mockReturnValue(null);
    expect(await captureRejection(installCronSchedule(options))).toMatchObject({ code: 'bunx-not-found' });
    which.mockReturnValue('/invalid\nbunx');
    expect(await captureRejection(installCronSchedule(options))).toMatchObject({ code: 'invalid-cron-value' });
    expect(calls).toEqual([]);
  });

  test('rolls back a new schedule when bunx disappears before writing the runner', async () => {
    const bunx = Bun.which('bunx');
    spyOn(Bun, 'which').mockReturnValueOnce(bunx).mockReturnValue(null);
    expect(await captureRejection(installCronSchedule(options))).toMatchObject({
      code: 'cron-install-failed',
      message: expect.stringContaining('bunx'),
    });
    expect(calls).toEqual(['remove']);
    expect(showCronSchedule(options.database).installed).toBe(false);
  });

  test('preserves the original registration error if cleanup also fails', async () => {
    const cron = Object.assign(
      mock(async () => {
        throw new Error('registration unavailable');
      }),
      {
        parse: originalCron.parse.bind(originalCron),
        remove: mock(async () => {
          throw new Error('cleanup unavailable');
        }),
      },
    );
    Object.assign(Bun, { cron });
    expect(await captureRejection(installCronSchedule(options))).toMatchObject({
      code: 'cron-install-failed',
      message: 'Não foi possível instalar o agendamento: registration unavailable',
    });
    expect(cron.remove).toHaveBeenCalledTimes(1);
    expect(showCronSchedule(options.database).installed).toBe(false);
  });

  test('restores the previous schedule and files after a failed update', async () => {
    const installed = await installCronSchedule(options);
    const metadata = join(dirname(installed.runner), `${installed.id}.json`);
    const originalRunner = readFileSync(installed.runner, 'utf8');
    const originalMetadata = readFileSync(metadata, 'utf8');
    const cron = Object.assign(mock(async () => {}).mockRejectedValueOnce('registration failed'), {
      parse: originalCron.parse.bind(originalCron),
      remove: mock(async () => {}),
    });
    Object.assign(Bun, { cron });
    expect(await captureRejection(installCronSchedule({ ...options, expression: '30 6 * * 5' }))).toMatchObject({
      code: 'cron-install-failed',
      message: expect.stringContaining('registration failed'),
    });
    expect(cron).toHaveBeenCalledTimes(2);
    expect(cron).toHaveBeenLastCalledWith(installed.runner, options.expression, installed.title);
    expect(readFileSync(installed.runner, 'utf8')).toBe(originalRunner);
    expect(readFileSync(metadata, 'utf8')).toBe(originalMetadata);
    expect(showCronSchedule(options.database).expression).toBe(options.expression);
  });

  test('keeps local schedule state when the OS refuses removal', async () => {
    const installed = await installCronSchedule(options);
    spyOn(Bun.cron, 'remove').mockRejectedValue(new Error('scheduler unavailable'));
    expect(await captureRejection(removeCronSchedule(options.database))).toMatchObject({ code: 'cron-remove-failed' });
    expect(existsSync(installed.runner)).toBe(true);
    expect(showCronSchedule(options.database).installed).toBe(true);
  });

  test('rejects invalid and incomplete configuration, and supports older metadata without a source', async () => {
    const installed = await installCronSchedule(options);
    const metadata = join(dirname(installed.runner), `${installed.id}.json`);
    const saved = JSON.parse(readFileSync(metadata, 'utf8'));
    delete saved.source;
    writeFileSync(metadata, JSON.stringify(saved));
    expect(showCronSchedule(options.database).source).toBe(EDNE_DOWNLOAD_URL);
    writeFileSync(metadata, JSON.stringify({ ...saved, database: 'different.db' }));
    expect(() => showCronSchedule(options.database)).toThrow(expect.objectContaining({ code: 'cron-config-invalid' }));
    writeFileSync(metadata, '{');
    expect(() => showCronSchedule(options.database)).toThrow(expect.objectContaining({ code: 'cron-config-invalid' }));
    rmSync(metadata);
    expect(() => showCronSchedule(options.database)).toThrow('incompleta');
  });

  test('propagates state-directory access failures', () => {
    const path = join(directory, 'loop');
    symlinkSync(path, path);
    Bun.env['XDG_STATE_HOME'] = path;
    expect(() => showCronSchedule(options.database)).toThrow(expect.objectContaining({ code: 'ELOOP' }));
  });

  test('uses the platform state directory when XDG_STATE_HOME is absent', async () => {
    delete Bun.env['XDG_STATE_HOME'];
    const preview = await installCronSchedule({ ...options, dryRun: true });
    const expected = process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : join(homedir(), '.local', 'state');
    expect(preview.runner.startsWith(expected)).toBe(true);
    expect(preview.status).toBe('preview');
    expect(calls).toEqual([]);
  });
});
