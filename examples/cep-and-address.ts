/** Run: bun examples/cep-and-address.ts ' 01001-000 ' */
import {
  CEP_RANGES,
  cepToU32,
  expandAddress,
  formatCep,
  normalizeCep,
  ufForCep,
} from '../src/library.ts';

const input = process.argv[2] ?? ' 01001-000 ';
const cep = normalizeCep(input);
console.log({ input, normalized: cep, formatted: formatCep(input) });
if (cep !== undefined) {
  const numeric = cepToU32(cep);
  console.log({ numeric, formattedNumber: formatCep(numeric), uf: ufForCep(cep) });
}

// cepToU32 is strict; normalizeCep accepts surrounding whitespace.
console.log({ invalid: normalizeCep('123'), invalidNumber: Number.isNaN(cepToU32('123')) });

console.table(
  CEP_RANGES.filter(([, , uf,]) => uf === 'SP').map(([first, last, uf,]) => ({
    uf,
    first: formatCep(first),
    last: formatCep(last),
  })),
);
// A postal range identifies the UF; it does not prove that a CEP exists.
console.log(expandAddress('Av. Dr. João, 123')); // AVENIDA DOUTOR JOAO 123
