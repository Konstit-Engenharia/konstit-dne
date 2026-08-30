import {
  command,
  parsers,
  positional,
} from '@konstit/cli';
import {
  readFile,
  writeFile,
} from 'node:fs/promises';
import {
  dirname,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = resolve(root, 'package.json');
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

interface PackageManifest extends Record<string, unknown> {
  readonly version: string;
}

const versionParser = parsers.custom<string>(
  'MAJOR.MINOR.PATCH',
  parseVersion,
);

const releaseCli = command('release', {
  about: 'Bump the package version and publish a GitHub Release',
  args: [
    positional('version', versionParser, {
      required: true,
      describe: 'New version, without a v prefix',
      valueName: 'MAJOR.MINOR.PATCH',
    }),
  ],
  handler: async ({ version }) => {
    await release(version);
  },
});

function parseVersion(input: string): string {
  if (!versionPattern.test(input)) {
    throw new Error('expected an exact major.minor.patch version');
  }
  try {
    Bun.semver.order(input, input);
  } catch {
    throw new Error('expected an exact major.minor.patch version');
  }
  return input;
}

async function release(nextVersion: string): Promise<void> {
  const packageText = await readFile(packagePath, 'utf8');
  const manifest = parsePackageManifest(packageText);
  const currentVersion = parseVersion(manifest.version);
  if (Bun.semver.order(nextVersion, currentVersion) <= 0) {
    throw new Error(
      `release version ${nextVersion} must be greater than current version ${currentVersion}`,
    );
  }

  const tag = `v${nextVersion}`;
  await validateRepository(tag);

  console.log('Running package checks...');
  await run(['bun', 'run', 'check']);
  await run(['bun', 'run', 'lint']);

  console.log(`Updating package version to ${nextVersion}...`);
  await writeFile(
    packagePath,
    `${JSON.stringify({ ...manifest, version: nextVersion }, null, 2)}\n`,
  );

  await run(['git', 'add', '--', 'package.json']);
  await run(['git', 'commit', '-m', `release: ${tag}`]);
  await run(['git', 'tag', '--annotate', tag, '--message', tag]);
  await run(['git', 'push', '--atomic', 'origin', 'main', `refs/tags/${tag}`]);

  try {
    await run([
      'gh',
      'release',
      'create',
      tag,
      '--verify-tag',
      '--generate-notes',
      '--title',
      tag,
    ]);
  } catch (error) {
    throw new Error(
      `the commit and tag were pushed, but GitHub Release creation failed; retry with: gh release create ${tag} --verify-tag --generate-notes --title ${tag}`,
      { cause: error },
    );
  }

  console.log(
    `Published GitHub Release ${tag}. GitHub Actions will attach the tarball and publish npm.`,
  );
}

function parsePackageManifest(source: string): PackageManifest {
  const value: unknown = JSON.parse(source);
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || typeof (value as Record<string, unknown>)['version'] !== 'string'
  ) {
    throw new TypeError('package.json must contain a string version');
  }
  return value as PackageManifest;
}

async function validateRepository(tag: string): Promise<void> {
  const repositoryRoot = await capture(['git', 'rev-parse', '--show-toplevel']);
  if (resolve(repositoryRoot) !== root) {
    throw new Error(`release must run in repository ${root}`);
  }

  const branch = await capture(['git', 'branch', '--show-current']);
  if (branch !== 'main') {
    throw new Error(`release must run on main, not ${branch || 'detached HEAD'}`);
  }

  const status = await capture(['git', 'status', '--porcelain']);
  if (status !== '') {
    throw new Error('release requires a clean working tree');
  }

  await run(['gh', 'auth', 'status']);
  await run(['git', 'fetch', 'origin', 'main', '--tags']);

  const relation = await capture([
    'git',
    'rev-list',
    '--left-right',
    '--count',
    'origin/main...HEAD',
  ]);
  const [behindText, aheadText,] = relation.split(/\s+/);
  const behind = Number(behindText);
  const ahead = Number(aheadText);
  if (!Number.isSafeInteger(behind) || !Number.isSafeInteger(ahead)) {
    throw new Error(`cannot read main branch relation: ${relation}`);
  }
  if (behind > 0) {
    throw new Error(
      `main is ${behind} commit(s) behind origin/main; update it before release`,
    );
  }

  const localTag = await capture(['git', 'tag', '--list', tag]);
  if (localTag !== '') {
    throw new Error(`tag ${tag} already exists locally`);
  }
  const remoteTag = await capture([
    'git',
    'ls-remote',
    '--tags',
    'origin',
    `refs/tags/${tag}`,
  ]);
  if (remoteTag !== '') {
    throw new Error(`tag ${tag} already exists on origin`);
  }
}

async function capture(args: readonly string[]): Promise<string> {
  const process = Bun.spawn([...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode,] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `command failed (${formatCommand(args)}): ${stderr.trim() || stdout.trim()}`,
    );
  }
  return stdout.trim();
}

async function run(args: readonly string[]): Promise<void> {
  console.log(`> ${formatCommand(args)}`);
  const process = Bun.spawn([...args], {
    cwd: root,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(
      `command failed with exit code ${exitCode}: ${formatCommand(args)}`,
    );
  }
}

function formatCommand(args: readonly string[]): string {
  return args.map((argument) =>
    /^[A-Za-z0-9_./:@=-]+$/.test(argument)
      ? argument
      : JSON.stringify(argument)
  ).join(' ');
}

if (import.meta.main) {
  try {
    process.exitCode = await releaseCli.run();
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
