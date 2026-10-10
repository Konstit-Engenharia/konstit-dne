/** Run: DNE_SQLITE_DATABASE=./data/dne.db bun examples/sqlite-reader.ts 01001-000 */
import {
  DneDatabaseReader,
  type DneBairro,
  type DneFaixaCep,
  type DneRow,
  type LoadMetadata,
} from '../src/library.ts';

// SQLite requires a database generated separately; the package includes a binary database.
const reader = new DneDatabaseReader(process.env['DNE_SQLITE_DATABASE'] ?? './data/dne.db');
try {
  const metadata: LoadMetadata | undefined = reader.metadata();
  console.log({ metadata, hasAddresses: reader.hasTable('dne'), rows: reader.rowCount('dne') });
  console.log({ schema: reader.tableSchema('dne') });

  const cep = process.argv[2] ?? '01001-000';
  const address: DneRow | undefined = reader.queryCep(cep);
  const neighborhood: DneBairro | undefined = reader.queryNeighborhoodByCep(cep);
  console.log({ address, neighborhood });
  if (neighborhood !== undefined) {
    const ranges: DneFaixaCep[] = reader.queryNeighborhoodCepRanges(neighborhood.bairro_id);
    console.log({ byId: reader.queryNeighborhood(neighborhood.bairro_id), ranges });
  }

  // Use application-owned SQL. The limit bounds returned rows, not execution time.
  const result = reader.querySql('SELECT cep, municipio, uf FROM dne ORDER BY cep', 3);
  console.table(result.rows);
  console.log({ truncated: result.truncated });
} finally {
  reader.close();
}
