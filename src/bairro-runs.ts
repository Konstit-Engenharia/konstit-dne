import { DneBinaryDatabaseFormatError } from './binary-db-errors.ts';
import {
  createPopcountTable,
  readPackedInteger,
  writePackedInteger,
  type BinaryRegion,
  type ByteWidth,
} from './binary-db-format.ts';

const HEADER_BYTES = 8;
const SAMPLE_SHIFT = 3;
const SAMPLE_STEP = 1 << SAMPLE_SHIFT;
const popcount = createPopcountTable();

export type BairroRuns = {
  highBitCount: number;
  highOffset: number;
  idWidth: ByteWidth;
  idsOffset: number;
  lowBits: number;
  lowOffset: number;
  runCount: number;
  samplesOffset: number;
  zeroCount: number;
};

/** Encodes consecutive equal neighborhood indexes; Elias–Fano stores each run's starting row. */
export function encodeBairroRuns(dense: Uint8Array, rowCount: number, idWidth: ByteWidth): Uint8Array {
  const view = new DataView(dense.buffer, dense.byteOffset, dense.byteLength);
  const starts: number[] = [];
  const ids: number[] = [];
  let previous = -1;
  for (let row = 0; row < rowCount; row++) {
    const id = readPackedInteger(view, row * idWidth, idWidth);
    if (id !== previous) {
      starts.push(row);
      ids.push(id);
      previous = id;
    }
  }

  const runCount = starts.length;
  const lowBits = Math.floor(Math.log2(rowCount / runCount));
  const lowBase = 2 ** lowBits;
  const zeroCount = Math.ceil(rowCount / lowBase);
  const highBitCount = zeroCount + runCount;
  const lowBytes = Math.ceil(runCount * lowBits / 8);
  const highBytes = Math.ceil(highBitCount / 8);
  const sampleCount = Math.ceil(zeroCount / SAMPLE_STEP);
  const highOffset = HEADER_BYTES + lowBytes;
  const samplesOffset = highOffset + highBytes;
  const idsOffset = samplesOffset + sampleCount * 4;
  const bytes = new Uint8Array(idsOffset + runCount * idWidth);
  const data = new DataView(bytes.buffer);
  data.setUint32(0, runCount, true);
  data.setUint8(4, lowBits);
  data.setUint8(5, SAMPLE_SHIFT);
  data.setUint8(6, idWidth);

  for (let index = 0; index < runCount; index++) {
    const start = starts[index] ?? 0;
    writeBits(bytes, HEADER_BYTES, index * lowBits, lowBits, start % lowBase);
    const highBit = Math.floor(start / lowBase) + index;
    const highByte = highOffset + (highBit >>> 3);
    bytes[highByte] = (bytes[highByte] ?? 0) | (1 << (highBit & 7));
    writePackedInteger(bytes, idsOffset + index * idWidth, ids[index] ?? 0, idWidth);
  }

  let zeroIndex = 0;
  for (let bit = 0; bit < highBitCount; bit++) {
    if (((bytes[highOffset + (bit >>> 3)] ?? 0) & (1 << (bit & 7))) === 0) {
      if (zeroIndex % SAMPLE_STEP === 0) {
        data.setUint32(samplesOffset + (zeroIndex >>> SAMPLE_SHIFT) * 4, bit, true);
      }
      zeroIndex++;
    }
  }
  return bytes;
}

/** Validates the complete encoded run index once when opening a v2 file. */
export function parseBairroRuns(
  data: DataView,
  region: BinaryRegion,
  rowCount: number,
  idWidth: ByteWidth,
  bairroCount: number,
): BairroRuns {
  if (region.length < HEADER_BYTES) {
    throw new DneBinaryDatabaseFormatError('Binary neighborhood runs are truncated');
  }
  const runCount = data.getUint32(region.offset, true);
  const lowBits = data.getUint8(region.offset + 4);
  if (
    runCount < 1 || runCount > rowCount || lowBits > 31
    || data.getUint8(region.offset + 5) !== SAMPLE_SHIFT
    || data.getUint8(region.offset + 6) !== idWidth
    || data.getUint8(region.offset + 7) !== 0
  ) {
    throw new DneBinaryDatabaseFormatError('Invalid binary neighborhood run header');
  }
  const lowBase = 2 ** lowBits;
  const zeroCount = Math.ceil(rowCount / lowBase);
  const highBitCount = zeroCount + runCount;
  const lowBytes = Math.ceil(runCount * lowBits / 8);
  const highBytes = Math.ceil(highBitCount / 8);
  const sampleCount = Math.ceil(zeroCount / SAMPLE_STEP);
  const lowOffset = region.offset + HEADER_BYTES;
  const highOffset = lowOffset + lowBytes;
  const samplesOffset = highOffset + highBytes;
  const idsOffset = samplesOffset + sampleCount * 4;
  if (idsOffset + runCount * idWidth !== region.offset + region.length) {
    throw new DneBinaryDatabaseFormatError('Invalid binary neighborhood run length');
  }

  let zeros = 0;
  let runs = 0;
  let previousStart = -1;
  let previousId = -1;
  for (let bit = 0; bit < highBitCount; bit++) {
    const one = (data.getUint8(highOffset + (bit >>> 3)) & (1 << (bit & 7))) !== 0;
    if (!one) {
      if (zeros >= zeroCount) {
        throw new DneBinaryDatabaseFormatError('Invalid binary neighborhood run bitmap');
      }
      if (zeros % SAMPLE_STEP === 0 && data.getUint32(samplesOffset + (zeros >>> SAMPLE_SHIFT) * 4, true) !== bit) {
        throw new DneBinaryDatabaseFormatError('Invalid binary neighborhood run samples');
      }
      zeros++;
      continue;
    }
    if (runs >= runCount) {
      throw new DneBinaryDatabaseFormatError('Invalid binary neighborhood run bitmap');
    }
    const low = readBits(data, lowOffset, runs * lowBits, lowBits);
    const start = zeros * lowBase + low;
    const id = readPackedInteger(data, idsOffset + runs * idWidth, idWidth);
    if ((runs === 0 && start !== 0) || start <= previousStart || start >= rowCount || id > bairroCount || id === previousId) {
      throw new DneBinaryDatabaseFormatError('Invalid binary neighborhood run');
    }
    previousStart = start;
    previousId = id;
    runs++;
  }
  if (zeros !== zeroCount || runs !== runCount || readBits(data, lowOffset, 0, lowBits) !== 0) {
    throw new DneBinaryDatabaseFormatError('Invalid binary neighborhood run boundaries');
  }
  if (highBitCount % 8 !== 0) {
    const paddingMask = 0xff << (highBitCount & 7);
    if ((data.getUint8(highOffset + (highBitCount >>> 3)) & paddingMask) !== 0) {
      throw new DneBinaryDatabaseFormatError('Invalid binary neighborhood run padding');
    }
  }
  return { highBitCount, highOffset, idWidth, idsOffset, lowBits, lowOffset, runCount, samplesOffset, zeroCount };
}

/** Finds the run containing a row using the Elias–Fano high bucket and its packed low values. */
export function readBairroRunIndex(data: DataView, runs: BairroRuns, row: number): number {
  const lowBase = 2 ** runs.lowBits;
  const high = Math.floor(row / lowBase);
  const end = selectZero(data, runs, high) - high;
  const start = high === 0 ? 0 : selectZero(data, runs, high - 1) - (high - 1);
  const wantedLow = row % lowBase;
  let low = start;
  let upper = end;
  while (low < upper) {
    const middle = low + ((upper - low) >>> 1);
    const value = readBits(data, runs.lowOffset, middle * runs.lowBits, runs.lowBits);
    if (value <= wantedLow) {
      low = middle + 1;
    } else {
      upper = middle;
    }
  }
  const runIndex = low - 1;
  return readPackedInteger(data, runs.idsOffset + runIndex * runs.idWidth, runs.idWidth);
}

function selectZero(data: DataView, runs: BairroRuns, zeroIndex: number): number {
  const sampleIndex = zeroIndex >>> SAMPLE_SHIFT;
  let bit = data.getUint32(runs.samplesOffset + sampleIndex * 4, true);
  let remaining = zeroIndex - sampleIndex * SAMPLE_STEP;
  if (remaining === 0) {
    return bit;
  }
  bit++;
  while (bit < runs.highBitCount) {
    const withinByte = bit & 7;
    const available = Math.min(8 - withinByte, runs.highBitCount - bit);
    const mask = (1 << available) - 1;
    const zeroBits = (~(data.getUint8(runs.highOffset + (bit >>> 3)) >>> withinByte)) & mask;
    const count = popcount[zeroBits] ?? 0;
    if (count >= remaining) {
      for (let offset = 0; offset < available; offset++) {
        if (zeroBits & (1 << offset)) {
          remaining--;
          if (remaining === 0) {
            return bit + offset;
          }
        }
      }
    }
    remaining -= count;
    bit += available;
  }
  throw new DneBinaryDatabaseFormatError('Invalid binary neighborhood run sample');
}

function readBits(data: DataView, byteOffset: number, bitOffset: number, count: number): number {
  let value = 0;
  for (let bit = 0; bit < count; bit++) {
    const position = bitOffset + bit;
    if (data.getUint8(byteOffset + (position >>> 3)) & (1 << (position & 7))) {
      value += 2 ** bit;
    }
  }
  return value;
}

function writeBits(bytes: Uint8Array, byteOffset: number, bitOffset: number, count: number, value: number) {
  for (let bit = 0; bit < count; bit++) {
    if (Math.floor(value / 2 ** bit) % 2) {
      const position = bitOffset + bit;
      const target = byteOffset + (position >>> 3);
      bytes[target] = (bytes[target] ?? 0) | (1 << (position & 7));
    }
  }
}
