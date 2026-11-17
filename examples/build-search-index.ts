/** Run: DNE_DATABASE=./data/dne.bin bun examples/build-search-index.ts ./data/dne.bin.search.bin */
import { writeFileSync } from 'node:fs';
import {
  buildAddressSearchIndex,
  DneBinaryDatabaseReader,
} from '../src/library.ts';

const output = process.argv[2];
if (!output) {
  throw new Error('Usage: bun examples/build-search-index.ts <new-index-path>');
}
const database = new DneBinaryDatabaseReader(process.env['DNE_DATABASE'] ?? './data/dne.bin');
try {
  // Build once for this exact database snapshot, outside the request path.
  const bytes: Uint8Array = buildAddressSearchIndex(database);
  writeFileSync(output, bytes, { flag: 'wx' });
  console.log({ output, bytes: bytes.byteLength, databaseChecksum: database.checksum() });
} finally {
  database.close();
}
