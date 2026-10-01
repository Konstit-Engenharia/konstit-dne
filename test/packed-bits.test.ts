import {
  expect,
  test,
} from 'bun:test';
import {
  integerBitWidth,
  readPackedBits,
  writePackedBits,
} from '../src/packed-bits.ts';

test('round-trips unsigned values at every bit width and byte alignment', () => {
  let state = 0x12345678;
  for (let width = 1; width <= 32; width++) {
    const max = 2 ** width - 1;
    const values = Array.from({ length: 263 }, (_, index) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return index % 3 === 0 ? max : index % 3 === 1 ? 0 : state % (max + 1);
    });
    const bytes = new Uint8Array(Math.ceil(values.length * width / 8));
    for (const [index, value,] of values.entries()) {
      writePackedBits(bytes, index, width, value);
    }
    const withPrefix = new Uint8Array(bytes.length + 3);
    withPrefix.set(bytes, 3);
    const data = new DataView(withPrefix.buffer);
    for (const [index, value,] of values.entries()) {
      expect(readPackedBits(data, 3, index, width)).toBe(value);
    }
  }
});

test('selects the width including the null ID and rejects values that do not fit', () => {
  expect(integerBitWidth(0)).toBe(1);
  expect(integerBitWidth(255)).toBe(8);
  expect(integerBitWidth(256)).toBe(9);
  expect(integerBitWidth(815305)).toBe(20);
  expect(integerBitWidth(0xffffffff)).toBe(32);
  expect(() => writePackedBits(new Uint8Array(4), 0, 20, 2 ** 20)).toThrow('Invalid');
  expect(() => writePackedBits(new Uint8Array(4), 0, 20, -1)).toThrow('Invalid');
});
