import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  cepToU32,
  collectCepInputs,
  formatCep,
  normalizeCep,
  splitCepStream,
  ufForCep,
} from '../src/cep.ts';
import { captureRejection } from './assertions.ts';

describe('CEP input service', () => {
  test.each(
    [
      ['01001-000', 'SP'],
      [1_000_000, 'SP'],
      [99_999_999, 'RS'],
      [68_900_000, 'AP'],
      [69_200_000, 'AM'],
      [69_300_000, 'RR'],
      [69_400_000, 'AM'],
      [70_000_000, 'DF'],
      [72_800_000, 'GO'],
      [73_000_000, 'DF'],
      [73_700_000, 'GO'],
    ] as const,
  )('finds UF for CEP %p', (value, expected) => {
    expect(ufForCep(value)).toBe(expected);
  });

  test.each(['abc', Number.NaN, -1, 999_999, 78_900_000, 100_000_000])('has no UF for CEP %p', (value) => {
    expect(ufForCep(value)).toBeUndefined();
  });

  test('reports a missing input file and does not read interactive stdin', async () => {
    expect(await captureRejection(collectCepInputs([], '/missing/dne/ceps.txt', true)[Symbol.asyncIterator]().next())).toMatchObject({
      code: 'input-file-not-found',
    });
    expect(await collectCepInputs([], undefined, true)[Symbol.asyncIterator]().next()).toMatchObject({ done: true });
  });

  test('converts valid plain and separated CEPs to uint32', () => {
    expect(cepToU32('01001000')).toBe(1_001_000);
    expect(cepToU32('01001-000')).toBe(1_001_000);
    expect(Number.isNaN(cepToU32('0100A000'))).toBeTrue();
    expect(Number.isNaN(cepToU32('01001_000'))).toBeTrue();
    expect(Number.isNaN(cepToU32('0100100'))).toBeTrue();
  });

  test('normalizes both supported formats and trims surrounding whitespace', () => {
    expect(normalizeCep('01001000')).toBe('01001000');
    expect(normalizeCep('01001-000')).toBe('01001000');
    expect(normalizeCep(' \t01001000\n')).toBe('01001000');
    expect(normalizeCep(' \t01001-000\n')).toBe('01001000');
    expect(normalizeCep('00000000')).toBe('00000000');
    expect(normalizeCep('99999999')).toBe('99999999');
  });

  test.each([
    ['01001000', '01001-000'],
    ['01001-000', '01001-000'],
    [' \t01001000\n', '01001-000'],
    [' \t01001-000\n', '01001-000'],
    ['00000000', '00000-000'],
    ['99999999', '99999-999'],
    [1_001_000, '01001-000'],
    [20_040_002, '20040-002'],
    [0, '00000-000'],
    [1, '00000-001'],
    [99_999_999, '99999-999'],
  ])('formats CEP %p as %s', (value, expected) => {
    expect(formatCep(value)).toBe(expected);
  });

  test.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
    1_001_000.5,
    100_000_000,
    Number.MAX_SAFE_INTEGER,
  ])('returns undefined when formatting invalid numeric CEP %p', (value) => {
    expect(formatCep(value)).toBeUndefined();
  });

  test.each([
    '',
    '   ',
    'abc',
    '1001000',
    '100000000',
    '0100A000',
    '０１００１０００',
    '01001_000',
    '0100-1000',
    '01001--000',
    '01001 000',
  ])('returns undefined when normalizing or formatting invalid CEP %p', (value) => {
    expect(normalizeCep(value)).toBeUndefined();
    expect(formatCep(value)).toBeUndefined();
  });

  test('streams tokens across chunk boundaries', async () => {
    const yielded: string[] = [];
    for await (const value of splitCepStream(chunks('01001', '-000\n200', '40002, 30140071'))) {
      yielded.push(value);
    }
    expect(yielded).toEqual(['01001-000', '20040002', '30140071']);
  });
});

async function* chunks(...values: string[]) {
  const encoder = new TextEncoder();
  for (const value of values) {
    yield encoder.encode(value);
  }
}
