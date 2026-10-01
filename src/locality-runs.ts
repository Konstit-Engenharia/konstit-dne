import { DneBinaryDatabaseFormatError } from './binary-db-errors.ts';
import {
  readPackedInteger,
  writePackedInteger,
  type BinaryRegion,
  type ByteWidth,
} from './binary-db-format.ts';

const HEADER_BYTES = 8;
const BLOCK_SHIFT = 8;
const BLOCK_ROWS = 1 << BLOCK_SHIFT;

export type LocalityRuns = {
  count: number;
  directoryOffset: number;
  startsOffset: number;
  idsOffset: number;
};

/** Groups consecutive rows with the same municipality and locality indicators. */
export function encodeLocalityRuns(ids: Uint8Array, flags: Uint8Array, width: ByteWidth) {
  const source = new DataView(ids.buffer, ids.byteOffset, ids.byteLength);
  const starts: number[] = [];
  const runIds: number[] = [];
  const runFlags: number[] = [];
  let previousId = -1;
  let previousFlags = -1;
  for (let row = 0; row < flags.length; row++) {
    const id = readPackedInteger(source, row * width, width);
    const indicators = flags[row] ?? 0;
    if (id !== previousId || indicators !== previousFlags) {
      starts.push(row);
      runIds.push(id);
      runFlags.push(indicators);
      previousId = id;
      previousFlags = indicators;
    }
  }
  const count = starts.length;
  const blockCount = Math.ceil(flags.length / BLOCK_ROWS);
  const startsOffset = HEADER_BYTES + (blockCount + 1) * 4;
  const idsOffset = startsOffset + count * 4;
  const bytes = new Uint8Array(idsOffset + count * width);
  const data = new DataView(bytes.buffer);
  data.setUint32(0, count, true);
  data.setUint8(4, BLOCK_SHIFT);
  let run = 0;
  for (let block = 0; block < blockCount; block++) {
    while (run + 1 < count && (starts[run + 1] ?? 0) <= block * BLOCK_ROWS) {
      run++;
    }
    data.setUint32(HEADER_BYTES + block * 4, run, true);
  }
  data.setUint32(HEADER_BYTES + blockCount * 4, count, true);
  for (let index = 0; index < count; index++) {
    data.setUint32(startsOffset + index * 4, starts[index] ?? 0, true);
    writePackedInteger(bytes, idsOffset + index * width, runIds[index] ?? 0, width);
  }
  return { ids: bytes, flags: Uint8Array.from(runFlags) };
}

/** Reads locations after the file has passed integrity verification. */
export function readLocalityRunsLayout(data: DataView, region: BinaryRegion, rows: number): LocalityRuns {
  const count = data.getUint32(region.offset, true);
  const directoryOffset = region.offset + HEADER_BYTES;
  const startsOffset = directoryOffset + (Math.ceil(rows / BLOCK_ROWS) + 1) * 4;
  return { count, directoryOffset, startsOffset, idsOffset: startsOffset + count * 4 };
}

/** Validates run starts and the directory used to bound each row lookup. */
export function parseLocalityRuns(data: DataView, region: BinaryRegion, rows: number, width: ByteWidth): LocalityRuns {
  if (region.length < HEADER_BYTES) {
    throw new DneBinaryDatabaseFormatError('Binary locality runs are truncated');
  }
  const count = data.getUint32(region.offset, true);
  if (count === 0 || count > rows || data.getUint32(region.offset + 4, true) !== BLOCK_SHIFT) {
    throw new DneBinaryDatabaseFormatError('Invalid binary locality run header');
  }
  const blockCount = Math.ceil(rows / BLOCK_ROWS);
  const directoryOffset = region.offset + HEADER_BYTES;
  const startsOffset = directoryOffset + (blockCount + 1) * 4;
  const idsOffset = startsOffset + count * 4;
  if (idsOffset + count * width !== region.offset + region.length) {
    throw new DneBinaryDatabaseFormatError('Invalid binary locality run length');
  }
  let previous = -1;
  for (let run = 0; run < count; run++) {
    const start = data.getUint32(startsOffset + run * 4, true);
    if ((run === 0 && start !== 0) || start <= previous || start >= rows) {
      throw new DneBinaryDatabaseFormatError('Invalid binary locality run boundary');
    }
    previous = start;
  }
  let run = 0;
  for (let block = 0; block < blockCount; block++) {
    while (run + 1 < count && data.getUint32(startsOffset + (run + 1) * 4, true) <= block * BLOCK_ROWS) {
      run++;
    }
    if (data.getUint32(directoryOffset + block * 4, true) !== run) {
      throw new DneBinaryDatabaseFormatError('Invalid binary locality run directory');
    }
  }
  if (data.getUint32(directoryOffset + blockCount * 4, true) !== count) {
    throw new DneBinaryDatabaseFormatError('Invalid binary locality run sentinel');
  }
  return { count, directoryOffset, startsOffset, idsOffset };
}

/** Returns the run that contains the row; only runs touching its 256-row block are searched. */
export function findLocalityRun(data: DataView, runs: LocalityRuns, row: number): number {
  const block = Math.floor(row / BLOCK_ROWS);
  let low = data.getUint32(runs.directoryOffset + block * 4, true);
  let high = Math.min(runs.count, data.getUint32(runs.directoryOffset + (block + 1) * 4, true) + 1);
  while (low + 1 < high) {
    const middle = low + ((high - low) >>> 1);
    if (data.getUint32(runs.startsOffset + middle * 4, true) <= row) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return low;
}
