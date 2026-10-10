/** Run: DNE_DATABASE=./data/dne.bin DNE_SQLITE_DATABASE=./data/dne.db bun examples/reader-disposal.ts */
import {
  DneBinaryDatabaseReader,
  DneDatabaseReader,
} from '../src/library.ts';

const cep = process.argv[2] ?? '01001-000';
{
  using binary = new DneBinaryDatabaseReader(process.env['DNE_DATABASE']);
  console.log({ binary: binary.queryCep(cep), rows: binary.rowCount() });
  // Symbol.dispose calls close() on scope exit, including if a query throws.
}

{
  using sqlite = new DneDatabaseReader(process.env['DNE_SQLITE_DATABASE'] ?? './data/dne.db');
  console.log({ sqlite: sqlite.queryCep(cep), rows: sqlite.rowCount('dne') });
}

// Manual disposal is also available and can be combined with an earlier close().
const reader = new DneBinaryDatabaseReader(process.env['DNE_DATABASE']);
reader.close();
reader[Symbol.dispose]();
