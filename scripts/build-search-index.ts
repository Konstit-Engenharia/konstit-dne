import { resolve } from 'node:path';
import {
  buildAddressSearchIndex,
  DneBinaryDatabaseReader,
} from '../src/library.ts';

const [databasePath = 'data/dne.bin', indexPath = 'data/dne.search.bin',] = Bun.argv.slice(2);
if (resolve(databasePath) === resolve(indexPath)) {
  throw new Error('Search index output must differ from the database path');
}
const database = new DneBinaryDatabaseReader(databasePath);
try {
  const started = performance.now();
  const bytes = buildAddressSearchIndex(database);
  await Bun.write(indexPath, bytes);
  console.log(JSON.stringify({ path: indexPath, rows: database.rowCount(), bytes: bytes.length, buildMs: performance.now() - started }));
} finally {
  database.close();
}
