import type { AddressSearchOptions } from '../src/library.ts';

/** Fixed workload shared by latency measurements and comparisons with the previous implementation. */
export const addressSearchCases: { query: string; options?: AddressSearchOptions; }[] = [
  { query: 'rubens mei' },
  { query: 'rubens mei', options: { uf: 'SP' } },
  { query: 'rubens mei', options: { municipioCodIbge: 3550308 } },
  { query: 'rubens mei 01141-000', options: { uf: 'SP' } },
  { query: 'paulista', options: { uf: 'SP' } },
  { query: 'paulista', options: { municipioCodIbge: 3550308 } },
  { query: '25 de mar', options: { municipioCodIbge: 3550308 } },
  { query: 'joao', options: { uf: 'SP' } },
  { query: 'joao', options: { municipioCodIbge: 3550308 } },
  { query: 'sao', options: { municipioCodIbge: 3550308 } },
  { query: 'sao' },
  { query: 'zzzzzzzzzz' },
  { query: '01141-000' },
];
