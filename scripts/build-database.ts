import { runCli } from '../src/cli.ts';

const source = process.env['EDNE_SOURCE_URL'];
if (!source) {
  throw new Error('Set EDNE_SOURCE_URL in .env or the environment.');
}

process.exitCode = await runCli(['build', '--source', source, ...Bun.argv.slice(2)]);
