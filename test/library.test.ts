import {
  expect,
  test,
} from 'bun:test';
import {
  cepToU32,
  DneBinaryDatabaseReader,
  formatCep,
  normalizeCep,
  parseUF,
  stateCodeToUF,
  stateNameToUF,
  ufForCep,
  ufToStateCode,
  ufToStateName,
} from '../src/library.ts';

test('exposes the reader and CEP helpers through the public library entry point', () => {
  expect(DneBinaryDatabaseReader).toBeFunction();
  expect(cepToU32('01001-000')).toBe(1_001_000);
  expect(normalizeCep(' 01001-000 ')).toBe('01001000');
  expect(formatCep(1_001_000)).toBe('01001-000');
  expect(ufForCep('01001-000')).toBe('SP');
  expect(parseUF(' sp ')).toBe('SP');
});

test('exposes state conversions through the public library entry point', () => {
  expect(ufToStateName(' sp ')).toBe('São Paulo');
  expect(stateNameToUF(' sao paulo ')).toBe('SP');
  expect(ufToStateCode(' sp ')).toBe(35);
  expect(stateCodeToUF(35)).toBe('SP');
});
