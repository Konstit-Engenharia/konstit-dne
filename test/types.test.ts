import {
  expect,
  test,
} from 'bun:test';
import {
  ALL_UFS,
  parseUF,
  stateCodes,
} from '../src/types.ts';

test('parses UF abbreviations case-insensitively and trims whitespace', () => {
  expect(parseUF(' sp ')).toBe('SP');
  expect(parseUF('mG')).toBe('MG');
  expect(ALL_UFS).toHaveLength(27);
  expect(new Set(ALL_UFS).size).toBe(27);
  expect(stateCodes.SP).toBe(35);
});

test.each(['', 'ZZ', 'São Paulo', '35', 'toString', '__proto__'])('rejects unknown UF %p', (value) => {
  expect(() => parseUF(value)).toThrow(`Unknown UF: ${value}`);
});
