import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli.ts';
import { EDNE_DOWNLOAD_URL } from '../src/settings.ts';

// Generate the release snapshot before packing; installations only read this file.
const database = fileURLToPath(new URL('../data/dne.bin', import.meta.url));
const source = process.env['DNE_PACKAGE_SOURCE'] ?? EDNE_DOWNLOAD_URL;
process.exitCode = await runCli(['build', '--format', 'binary', '--db', database, '--source', source]);
