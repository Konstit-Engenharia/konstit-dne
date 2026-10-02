import {
  expect,
  test,
} from 'bun:test';
import {
  ALL_UFS,
  parseUF,
  stateCodes,
  stateCodeToUF,
  stateNameToUF,
  ufToStateCode,
  ufToStateName,
} from '../src/types.ts';

test('parses UF abbreviations case-insensitively and trims whitespace', () => {
  expect(parseUF(' sp ')).toBe('SP');
  expect(parseUF('mG')).toBe('MG');
  expect(ALL_UFS).toHaveLength(27);
  expect(new Set(ALL_UFS).size).toBe(27);
  expect(stateCodes.SP).toBe(35);
});

test.each(['', 'ZZ', 'São Paulo', '35', 'toString', '__proto__'])('returns null for unknown UF %p', (value) => {
  expect(parseUF(value)).toBeNull();
});

test.each(
  [
    ['RO', 'Rondônia', 11],
    ['AC', 'Acre', 12],
    ['AM', 'Amazonas', 13],
    ['RR', 'Roraima', 14],
    ['PA', 'Pará', 15],
    ['AP', 'Amapá', 16],
    ['TO', 'Tocantins', 17],
    ['MA', 'Maranhão', 21],
    ['PI', 'Piauí', 22],
    ['CE', 'Ceará', 23],
    ['RN', 'Rio Grande do Norte', 24],
    ['PB', 'Paraíba', 25],
    ['PE', 'Pernambuco', 26],
    ['AL', 'Alagoas', 27],
    ['SE', 'Sergipe', 28],
    ['BA', 'Bahia', 29],
    ['MG', 'Minas Gerais', 31],
    ['ES', 'Espírito Santo', 32],
    ['RJ', 'Rio de Janeiro', 33],
    ['SP', 'São Paulo', 35],
    ['PR', 'Paraná', 41],
    ['SC', 'Santa Catarina', 42],
    ['RS', 'Rio Grande do Sul', 43],
    ['MS', 'Mato Grosso do Sul', 50],
    ['MT', 'Mato Grosso', 51],
    ['GO', 'Goiás', 52],
    ['DF', 'Distrito Federal', 53],
  ] as const,
)('converts the name and IBGE code for %s', (uf, name, code) => {
  expect(ufToStateName(uf)).toBe(name);
  expect(ufToStateName(` ${uf.toLowerCase()} `)).toBe(name);
  expect(stateNameToUF(name)).toBe(uf);
  expect(ufToStateCode(uf)).toBe(code);
  expect(ufToStateCode(` ${uf.toLowerCase()} `)).toBe(code);
  expect(stateCodeToUF(code)).toBe(uf);
});

test.each(['', ' ', 'ZZ', 'São Paulo', '35', 'toString', '__proto__'])('returns undefined for invalid UF %p', (uf) => {
  expect(ufToStateName(uf)).toBeUndefined();
  expect(ufToStateCode(uf)).toBeUndefined();
});

test.each(
  [
    [' sao paulo ', 'SP'],
    ['MARANHAO', 'MA'],
    [' espÍRITO santo ', 'ES'],
    ['paraiba', 'PB'],
    ['  rio GRANDE do sul  ', 'RS'],
    ['Goia\u0301s', 'GO'],
  ] as const,
)('normalizes the state name %p', (name, uf) => {
  expect(stateNameToUF(name)).toBe(uf);
});

test.each(['', ' ', 'ZZ', 'SP', '35', 'SantaCatarina', 'toString', '__proto__'])('returns undefined for unknown state name %p', (name) => {
  expect(stateNameToUF(name)).toBeUndefined();
});

test.each([0, -11, 10, 36, 54, 3_500_000, 35.1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
  'returns undefined for invalid state code %p',
  (code) => {
    expect(stateCodeToUF(code)).toBeUndefined();
  },
);
