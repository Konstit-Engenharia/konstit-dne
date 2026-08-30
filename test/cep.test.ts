import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  normalizeCep,
  splitCepStream,
} from '../src/cep.ts';
import { UserError } from '../src/errors.ts';

describe('CEP input service', () => {
  test('normalizes both supported formats with one stable error', () => {
    expect(normalizeCep('01001000')).toBe('01001000');
    expect(normalizeCep('01001-000')).toBe('01001000');
    try {
      normalizeCep('abc');
      throw new Error('expected normalizeCep to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(UserError);
      expect((error as UserError).code).toBe('invalid-cep');
    }
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
