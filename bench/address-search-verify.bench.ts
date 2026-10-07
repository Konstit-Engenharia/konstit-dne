import { deepStrictEqual } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { addressTokens } from '../src/address-search-text.ts';
import {
  DneAddressSearch,
  DneBinaryDatabaseReader,
} from '../src/library.ts';
import { addressSearchCases } from './address-search-cases.ts';

const [databasePath, previousModule, previousIndex, currentIndex,] = Bun.argv.slice(2);
if (!databasePath || !previousModule || !previousIndex || !currentIndex) {
  throw new Error('Usage: address-search-verify.bench.ts database previous-library.ts previous-index current-index');
}
const previous = await import(pathToFileURL(resolve(previousModule)).href) as typeof import('../src/library.ts');
const database = new DneBinaryDatabaseReader(databasePath);
const previousDatabase = new previous.DneBinaryDatabaseReader(databasePath);
const current = new DneAddressSearch(database, readFileSync(currentIndex));
const reference = new previous.DneAddressSearch(previousDatabase, readFileSync(previousIndex));

try {
  const cases = [...addressSearchCases];
  const stride = Math.ceil(database.rowCount() / 40);
  let id = 0;
  for (const row of database.entries()) {
    if (id++ % stride !== 0 || !row.logradouro) {
      continue;
    }
    const words = addressTokens(row.logradouro).slice(0, 3);
    const query = words.map((word, position) => position === words.length - 1 ? word.slice(0, 3) : word).join(' ');
    cases.push(
      { query, options: { municipioCodIbge: row.municipio_cod_ibge, limit: 50 } },
      { query, options: { uf: row.uf, limit: 3 } },
      { query: `${query} ${row.cep}`, options: { uf: row.uf } },
      { query: [...words].reverse().join(' '), options: { municipioCodIbge: row.municipio_cod_ibge } },
    );
  }
  let returnedAddresses = 0;
  for (const { query, options } of cases) {
    const expected = reference.searchAddresses(query, options);
    const actual = current.searchAddresses(query, options);
    deepStrictEqual(actual, expected, JSON.stringify({ query, options }));
    returnedAddresses += actual.length;
  }
  console.log(
    JSON.stringify(
      {
        databaseChecksum: database.checksum(),
        rows: database.rowCount(),
        comparedQueries: cases.length,
        returnedAddresses,
        sameResultsAndOrder: true,
      },
      null,
      2,
    ),
  );
} finally {
  current.close();
  reference.close();
  database.close();
  previousDatabase.close();
}
