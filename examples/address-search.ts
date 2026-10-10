/** Run: DNE_SEARCH_INDEX=./data/dne.bin.search.bin bun examples/address-search.ts 'paulista' */
import { readFileSync } from 'node:fs';
import {
  DneAddressSearch,
  DneBinaryDatabaseReader,
  type AddressSearchOptions,
} from '../src/library.ts';

const databasePath = process.env['DNE_DATABASE'];
const indexPath = process.env['DNE_SEARCH_INDEX'] ?? `${databasePath ?? './data/dne.bin'}.search.bin`;
const text = process.argv[2] ?? 'paulista';
using database = new DneBinaryDatabaseReader(databasePath);
{
  using search = new DneAddressSearch(database, indexPath);
  const options: AddressSearchOptions = { uf: 'SP', municipioCodIbge: 3550308, limit: 5 };
  console.log({ filtered: search.searchAddresses(text, options) });
  console.log({ unfiltered: search.searchAddresses(text, { limit: 5 }) });
  console.log({ exactCep: search.searchAddresses('01001-000') });
  console.log({ municipalityFromCep: search.searchAddresses(`${text} 01001-000`) });
}

// Disposing the first search leaves the database open for another search.
// Alternative input: caller-owned bytes are copied by the constructor.
const bytes = readFileSync(indexPath);
{
  using fromBytes = new DneAddressSearch(database, bytes);
  console.log({ fromBytes: fromBytes.searchAddresses(text, { limit: 5 }) });
}
// The database is disposed after both searches when the enclosing scope ends.
