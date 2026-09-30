import {
  bench,
  run,
  summary,
} from 'mitata';
import { selectDelimitedFields } from '../src/dne-source-parser.ts';

const logradouroLine = [
  '300001',
  'SP',
  '100001',
  '200001',
  '',
  'Endereco Principal Com Nome Medio',
  '',
  '30000001',
  'Rua',
  'S',
  'End Principal',
].join('@');

const paddedLogradouroLine = [
  '300001',
  ' SP ',
  '100001',
  '200001',
  '',
  ' Endereco Principal Com Nome Medio ',
  '',
  '30000001',
  ' Rua ',
  'S',
  'End Principal',
].join('@');

const localidadeLine = ['100001', 'SP', 'Municipio Longo', '10000001', '1', 'M', '', 'Mun Longo', '3500001'].join('@');
const logradouroIndexes = [1, 2, 3, 5, 7, 8, 9];
const localidadeIndexes = [0, 1, 2, 3, 6, 8];

const insertRows = Array.from(
  { length: 1000 },
  (_, index) =>
    [
      String(30000000 + index),
      `Rua Endereco ${index}`,
      null,
      `Bairro ${index}`,
      `Municipio ${index}`,
      3500000 + index,
      index % 2 === 0 ? 'SP' : 'BA',
      null,
    ] as const,
);

summary(() => {
  bench('selectDelimitedFields logradouro', () => {
    selectDelimitedFields(logradouroLine, logradouroIndexes);
  });

  bench('selectDelimitedFields logradouro padded', () => {
    selectDelimitedFields(paddedLogradouroLine, logradouroIndexes);
  });

  bench('split/map logradouro', () => {
    const fields = logradouroLine.split('@').map((field) => {
      const value = field.trim();
      return value === '' ? null : value;
    });
    return [fields[1], fields[2], fields[3], fields[5], fields[7], fields[8], fields[9]];
  });

  bench('selectDelimitedFields localidade', () => {
    selectDelimitedFields(localidadeLine, localidadeIndexes);
  });

  bench('split/map localidade', () => {
    const fields = localidadeLine.split('@').map((field) => {
      const value = field.trim();
      return value === '' ? null : value;
    });
    return [fields[0], fields[1], fields[2], fields[3], fields[6], fields[8]];
  });

  bench('flatten 1000 insert rows', () => {
    const params = Array.from({ length: insertRows.length * 8 }, () => null as string | number | null);
    for (let rowIndex = 0; rowIndex < insertRows.length; rowIndex++) {
      const row = insertRows[rowIndex];
      if (!row) {
        throw new Error(`Missing row at index ${rowIndex}`);
      }
      const offset = rowIndex * 8;
      params[offset] = row[0];
      params[offset + 1] = row[1];
      params[offset + 2] = row[2];
      params[offset + 3] = row[3];
      params[offset + 4] = row[4];
      params[offset + 5] = row[5];
      params[offset + 6] = row[6];
      params[offset + 7] = row[7];
    }
    return params;
  });
});

await run({
  colors: !envValue('NO_COLOR'),
});

function envValue(name: string) {
  return Bun.env[name];
}
