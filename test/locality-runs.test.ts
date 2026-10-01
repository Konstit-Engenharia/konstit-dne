import {
  expect,
  test,
} from 'bun:test';
import {
  readPackedInteger,
  writePackedInteger,
  type ByteWidth,
} from '../src/binary-db-format.ts';
import {
  encodeLocalityRuns,
  findLocalityRun,
  parseLocalityRuns,
} from '../src/locality-runs.ts';

test.each([1, 2, 3, 4] as const)('round-trips municipality and flag changes with %i-byte IDs', (width: ByteWidth) => {
  const rows = 2_563;
  const ids = new Uint8Array(rows * width);
  const flags = Uint8Array.from({ length: rows }, (_, row) => row < 1_000 ? 1 : row % 12);
  const expected = Array.from({ length: rows }, (_, row) => row < 256 ? 1 : row < 512 ? 2 : 2 ** (8 * (width - 1)) + 1);
  for (const [row, value,] of expected.entries()) {
    writePackedInteger(ids, row * width, value, width);
  }
  const encoded = encodeLocalityRuns(ids, flags, width);
  const data = new DataView(encoded.ids.buffer);
  const runs = parseLocalityRuns(data, { offset: 0, length: encoded.ids.length }, rows, width);
  for (const [row, id,] of expected.entries()) {
    const run = findLocalityRun(data, runs, row);
    expect(readPackedInteger(data, runs.idsOffset + run * width, width)).toBe(id);
    expect(encoded.flags[run]).toBe(flags[row]);
  }
});

test('supports a single row and a single run spanning many directory blocks', () => {
  for (const rows of [1, 4_097]) {
    const encoded = encodeLocalityRuns(new Uint8Array(rows).fill(7), new Uint8Array(rows).fill(1), 1);
    const data = new DataView(encoded.ids.buffer);
    const runs = parseLocalityRuns(data, { offset: 0, length: encoded.ids.length }, rows, 1);
    expect(runs.count).toBe(1);
    expect(findLocalityRun(data, runs, rows - 1)).toBe(0);
  }
});

test('rejects invalid run starts and directory entries before lookup', () => {
  const encoded = encodeLocalityRuns(Uint8Array.from([1, 1, 2, 2]), new Uint8Array(4), 1);
  const data = new DataView(encoded.ids.buffer);
  const region = { offset: 0, length: encoded.ids.length };
  const runs = parseLocalityRuns(data, region, 4, 1);
  for (const offset of [runs.directoryOffset, runs.directoryOffset + 4, runs.startsOffset, runs.startsOffset + 4]) {
    const corrupted = encoded.ids.slice();
    new DataView(corrupted.buffer).setUint32(offset, 99, true);
    expect(() => parseLocalityRuns(new DataView(corrupted.buffer), region, 4, 1)).toThrow('Invalid binary locality run');
  }
});
