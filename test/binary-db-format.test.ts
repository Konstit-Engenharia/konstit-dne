import {
  expect,
  test,
} from 'bun:test';
import {
  assertPackedInteger,
  BINARY_DATABASE_MAGIC,
  hasBinaryMagic,
  integerByteWidth,
  readPackedInteger,
  writePacked10,
  writePackedInteger,
} from '../src/binary-db-format.ts';

test('selects the minimum integer width at every byte boundary', () => {
  expect([0, 255, 256, 65535, 65536, 0xffffff, 0x1000000, 0xffffffff].map(integerByteWidth))
    .toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
});

test('reads and writes all four bytes of an unsigned integer in little-endian order', () => {
  const bytes = new Uint8Array(6).fill(0xaa);
  writePackedInteger(bytes, 1, 0xfedcba98, 4);
  expect([...bytes]).toEqual([0xaa, 0x98, 0xba, 0xdc, 0xfe, 0xaa]);
  expect(readPackedInteger(new DataView(bytes.buffer), 1, 4)).toBe(0xfedcba98);
});

test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 256])('rejects %p in a one-byte integer column', (value) => {
  expect(() => assertPackedInteger(value, 1, 'test')).toThrow('1-byte unsigned integer limit');
});

test('requires the complete binary signature without trailing bytes', () => {
  expect(hasBinaryMagic(BINARY_DATABASE_MAGIC)).toBe(true);
  expect(hasBinaryMagic(BINARY_DATABASE_MAGIC.subarray(0, -1))).toBe(false);
  expect(hasBinaryMagic(new Uint8Array([...BINARY_DATABASE_MAGIC, 0]))).toBe(false);
  expect(hasBinaryMagic(new Uint8Array(8))).toBe(false);
});

test('packs ten-bit values across byte boundaries and rejects overflow', () => {
  const bytes = new Uint8Array(5);
  for (const index of [0, 1, 2, 3]) {
    writePacked10(bytes, index, 1023);
  }
  expect([...bytes]).toEqual([255, 255, 255, 255, 255]);
  expect(() => writePacked10(bytes, 0, -1)).toThrow('10 bits');
  expect(() => writePacked10(bytes, 0, 1024)).toThrow('10 bits');
});
