import {
  expect,
  test,
} from 'bun:test';
import {
  encodeBairroRuns,
  parseBairroRuns,
  readBairroRunIndex,
} from '../src/bairro-runs.ts';
import {
  writePackedInteger,
  type ByteWidth,
} from '../src/binary-db-format.ts';

function roundTrip(ids: number[], width: ByteWidth) {
  const dense = new Uint8Array(ids.length * width);
  for (const [row, id,] of ids.entries()) {
    writePackedInteger(dense, row * width, id, width);
  }
  const encoded = encodeBairroRuns(dense, ids.length, width);
  const data = new DataView(encoded.buffer);
  const runs = parseBairroRuns(data, { offset: 0, length: encoded.length }, ids.length, width, Math.max(...ids));
  for (const [row, id,] of ids.entries()) {
    expect(readBairroRunIndex(data, runs, row)).toBe(id);
  }
  return { encoded, dense };
}

test('resolves every row across empty high buckets and long, short, and alternating runs', () => {
  roundTrip([0], 1);
  roundTrip(Array.from({ length: 5_000 }, () => 7), 1);
  roundTrip(Array.from({ length: 513 }, (_, row) => row % 2), 1);
  roundTrip([
    ...Array.from({ length: 1_000 }, () => 0),
    65_629,
    ...Array.from({ length: 700 }, () => 5),
    ...Array.from({ length: 1_200 }, (_, row) => row % 2 ? 65_629 : 0),
  ], 3);
});

test('compresses long repeated neighborhood indexes', () => {
  const { encoded, dense } = roundTrip(Array.from({ length: 4_096 }, (_, row) => Math.floor(row / 256)), 2);
  expect(encoded.length).toBeLessThan(dense.length / 10);
});

test('resolves runs with nonzero low bits and multiple starts in the same high bucket', () => {
  roundTrip(Array.from({ length: 512 }, (_, row) => row < 3 ? 1 : row < 11 ? 2 : row < 200 ? 3 : row < 501 ? 4 : 5), 1);
  roundTrip(Array.from({ length: 513 }, (_, row) => Math.floor(row / 3) % 2), 1);
});

test.each(
  [
    ['truncated', (bytes: Uint8Array) => bytes.subarray(0, 7), 'are truncated'],
    ['length', (bytes: Uint8Array) => bytes.subarray(0, -1), 'run length'],
    ['too many zeros', (bytes: Uint8Array) => {
      bytes[8] = 1;
      return bytes;
    }, 'run bitmap'],
    ['too many ones', (bytes: Uint8Array) => {
      bytes[8] = 13;
      return bytes;
    }, 'run bitmap'],
    ['padding', (bytes: Uint8Array) => {
      bytes[8] = 133;
      return bytes;
    }, 'run padding'],
  ] as const,
)('rejects %s neighborhood run data', (_name, mutate, message) => {
  const bytes = mutate(encodeBairroRuns(Uint8Array.of(1, 2), 2, 1));
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(() => parseBairroRuns(data, { offset: 0, length: bytes.length }, 2, 1, 2)).toThrow(message);
});

test('rejects corrupt run samples and IDs when opening', () => {
  const ids = [1, 1, 2, 2, 1, 1];
  const dense = new Uint8Array(ids);
  const encoded = encodeBairroRuns(dense, ids.length, 1);
  const wrongWidth = encoded.slice();
  wrongWidth[6] = 2;
  expect(() => parseBairroRuns(new DataView(wrongWidth.buffer), { offset: 0, length: wrongWidth.length }, ids.length, 1, 2))
    .toThrow('Invalid binary neighborhood run header');
  const wrongSample = encoded.slice();
  const runCount = new DataView(wrongSample.buffer).getUint32(0, true);
  const lowBits = wrongSample[4] ?? 0;
  const sampleOffset = 8 + Math.ceil(runCount * lowBits / 8)
    + Math.ceil((Math.ceil(ids.length / 2 ** lowBits) + runCount) / 8);
  wrongSample[sampleOffset] = 255;
  expect(() => parseBairroRuns(new DataView(wrongSample.buffer), { offset: 0, length: wrongSample.length }, ids.length, 1, 2))
    .toThrow('Invalid binary neighborhood run samples');
  const wrongId = encoded.slice();
  wrongId[wrongId.length - 1] = 3;
  expect(() => parseBairroRuns(new DataView(wrongId.buffer), { offset: 0, length: wrongId.length }, ids.length, 1, 2))
    .toThrow('Invalid binary neighborhood run');
});
