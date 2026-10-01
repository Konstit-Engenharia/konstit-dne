import {
  afterAll,
  beforeAll,
  expect,
  test,
} from 'bun:test';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BINARY_DATABASE_CHECKSUM_SIZE,
  BINARY_DATABASE_HEADER_SIZE,
  BINARY_DATABASE_VERSION,
  BINARY_SECTION_NAMES,
  DICTIONARY_BLOCK_SHIFT,
  DICTIONARY_BLOCK_SIZE,
  DICTIONARY_CODEC_FSST,
  DICTIONARY_HEADER_SIZE,
  FSST_SYMBOL_TABLE_SIZE,
  SECTION_TABLE_OFFSET,
} from '../src/binary-db-format.ts';
import { sealBinaryDatabaseBytes } from '../src/binary-db-integrity.ts';
import {
  DneBinaryDatabaseFormatError,
  DneBinaryDatabaseReader,
  DneBinaryDatabaseVersionError,
} from '../src/binary-db-reader.ts';
import { validateBinaryDatabaseBytes } from '../src/binary-db-validator.ts';
import { buildBinaryDatabase } from '../src/binary-db-writer.ts';
import {
  createFixture,
  fetchDatabase,
} from './helpers.ts';

const workDir = mkdtempSync(join(tmpdir(), 'dne-fsst-integration-'));
const binaryPath = join(workDir, 'source.bin');
const fsstPath = join(workDir, 'source-fsst.bin');
let original: Uint8Array<ArrayBuffer>;
let fsstBytes: Uint8Array<ArrayBuffer>;
let fsstLayout: FsstLayout;

beforeAll(async () => {
  const sourcePath = join(workDir, 'source');
  const sqlitePath = join(workDir, 'source.db');
  createFixture(sourcePath, 40);
  fetchDatabase(sqlitePath, sourcePath);
  await buildBinaryDatabase(sqlitePath, binaryPath);
  original = new Uint8Array(await Bun.file(binaryPath).arrayBuffer());
  const converted = convertLogradouroToFsst(original);
  fsstBytes = converted.bytes;
  fsstLayout = converted.layout;
  sealBinaryDatabaseBytes(fsstBytes);
  await Bun.write(fsstPath, fsstBytes);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

test('builds a version 5 database that can be opened, closed, and reopened', () => {
  expect(new DataView(original.buffer).getUint16(8, true)).toBe(BINARY_DATABASE_VERSION);

  const reader = new DneBinaryDatabaseReader(binaryPath);
  try {
    expect(reader.queryCep('30000001')?.logradouro).toBe('Rua Endereco 1');
  } finally {
    reader.close();
  }

  const reopened = new DneBinaryDatabaseReader(binaryPath);
  try {
    expect(reopened.queryCep('30000001')?.logradouro).toBe('Rua Endereco 1');
  } finally {
    reopened.close();
  }
});

test('reads an FSST logradouro dictionary through mmap and after reopening', () => {
  expect(fsstLayout.count).toBeGreaterThan(DICTIONARY_BLOCK_SIZE);
  const reader = new DneBinaryDatabaseReader(fsstPath);
  try {
    expect(reader.queryCep('30000001')?.logradouro).toBe('Rua Endereco 1');
  } finally {
    reader.close();
  }

  const reopened = new DneBinaryDatabaseReader(fsstPath);
  try {
    expect(reopened.queryCep('30000001')?.logradouro).toBe('Rua Endereco 1');
  } finally {
    reopened.close();
  }
});

test('validates a complete FSST dictionary with two-byte lengths and literal escapes', () => {
  expect(fsstLayout.lengthWidth).toBe(2);
  expect(() => validateBinaryDatabaseBytes(fsstBytes)).not.toThrow();
});

test('rejects an FSST suffix above the compressed byte limit', () => {
  const bytes = fsstBytes.slice();
  const dictionary = bytes.slice(fsstLayout.regionOffset, fsstLayout.regionOffset + fsstLayout.regionLength);
  const expanded = new Uint8Array(dictionary.length + 512);
  expanded.set(dictionary);
  const view = new DataView(expanded.buffer);
  view.setUint32(24, fsstLayout.suffixDataLength + 512, true);
  view.setUint16(fsstLayout.lengthsOffset - fsstLayout.regionOffset, 511, true);
  for (let block = 1; block < fsstLayout.blockCount; block++) {
    view.setUint32(fsstLayout.blockOffsetsOffset - fsstLayout.regionOffset + block * 4, fsstLayout.suffixDataLength + 512, true);
  }
  const repacked = repackDatabase(bytes, expanded);
  expect(() => validateBinaryDatabaseBytes(repacked.bytes)).toThrow('FSST suffix is too long');
});

test.each(
  [
    ['truncated region', (bytes: Uint8Array) => {
      const directory = SECTION_TABLE_OFFSET + BINARY_SECTION_NAMES.indexOf('logradouroDictionary') * 8;
      const view = new DataView(bytes.buffer);
      view.setUint32(directory + 4, fsstLayout.regionLength - 1, true);
    }, 'section padding'],
    ['invalid length width', (bytes: Uint8Array) => {
      bytes[fsstLayout.regionOffset + 31] = 0;
    }, 'codec or length width'],
    ['invalid symbol length', (bytes: Uint8Array) => {
      bytes[fsstLayout.symbolsOffset] = 9;
    }, 'FSST symbol length'],
  ] as const,
)('rejects %s during full validation', async (_name, mutate, message) => {
  const bytes = fsstBytes.slice();
  mutate(bytes);

  const error = captureError(() => validateBinaryDatabaseBytes(bytes));
  expect(error).toBeInstanceOf(DneBinaryDatabaseFormatError);
  expect(error.message).toContain(message);
});

test('rejects an unknown FSST symbol during full validation', async () => {
  const bytes = fsstBytes.slice();
  const offsets = entryPayloadOffsets(bytes, fsstLayout);
  bytes[fsstLayout.symbolsOffset + 254] = 0;
  for (const offset of offsets) {
    if (offset !== undefined) {
      bytes[fsstLayout.suffixDataOffset + offset] = 254;
    }
  }

  const error = captureError(() => validateBinaryDatabaseBytes(bytes));
  expect(error).toBeInstanceOf(DneBinaryDatabaseFormatError);
  expect(error.message).toContain('Invalid binary logradouro FSST symbol');
});

test('rejects dangling FSST escapes during full validation', async () => {
  const bytes = fsstBytes.slice();
  const offsets = entryPayloadOffsets(bytes, fsstLayout);
  for (let block = 0; block < fsstLayout.blockCount; block++) {
    const index = block * DICTIONARY_BLOCK_SIZE;
    const offset = offsets[index];
    if (offset !== undefined) {
      setCompressedLength(bytes, fsstLayout, index, 1);
      bytes[fsstLayout.suffixDataOffset + offset] = 255;
    }
  }

  const error = captureError(() => validateBinaryDatabaseBytes(bytes));
  expect(error).toBeInstanceOf(DneBinaryDatabaseFormatError);
  expect(error.message).toContain('Invalid binary logradouro FSST escape');
});

test('rejects a payload crossing the next FSST block boundary during full validation', async () => {
  const bytes = fsstBytes.slice();
  const view = new DataView(bytes.buffer);
  for (let block = 1; block < fsstLayout.blockCount; block++) {
    view.setUint32(fsstLayout.blockOffsetsOffset + block * 4, 0, true);
  }

  const error = captureError(() => validateBinaryDatabaseBytes(bytes));
  expect(error).toBeInstanceOf(DneBinaryDatabaseFormatError);
  expect(error.message).toContain('Invalid binary logradouro FSST suffix');
});

test.each([1, 2, 3, 4])('rejects legacy binary version %i', async (version) => {
  const bytes = original.slice();
  new DataView(bytes.buffer).setUint16(8, version, true);
  const path = join(workDir, `version-${version}.bin`);
  await Bun.write(path, bytes);

  let error: unknown;
  try {
    new DneBinaryDatabaseReader(path);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(DneBinaryDatabaseVersionError);
  expect(error).toMatchObject({
    actualVersion: version,
    supportedVersion: BINARY_DATABASE_VERSION,
  });
});

test('rejects FSST codec declarations on dictionaries other than logradouro', async () => {
  const bytes = original.slice();
  const offset = dictionaryOffset(bytes, 'bairroDictionary');
  bytes[offset + 30] = 2;
  bytes[offset + 31] = 1;

  expect(() => validateBinaryDatabaseBytes(bytes)).toThrow(DneBinaryDatabaseFormatError);
  expect(() => validateBinaryDatabaseBytes(bytes)).toThrow('Unsupported binary bairro dictionary codec');
});

test('rejects a nonzero encoded length width on a plain dictionary', async () => {
  const bytes = original.slice();
  const offset = dictionaryOffset(bytes, 'municipioDictionary');
  bytes[offset + 30] = 0;
  bytes[offset + 31] = 1;

  expect(() => validateBinaryDatabaseBytes(bytes)).toThrow(DneBinaryDatabaseFormatError);
  expect(() => validateBinaryDatabaseBytes(bytes)).toThrow('Unsupported binary municipio dictionary codec');
});

function dictionaryOffset(bytes: Uint8Array, name: (typeof BINARY_SECTION_NAMES)[number]) {
  return sectionRegion(bytes, name).offset;
}

type FsstLayout = {
  blockCount: number;
  blockOffsetsOffset: number;
  count: number;
  lengthWidth: 1 | 2;
  lengthsOffset: number;
  prefixesOffset: number;
  regionLength: number;
  regionOffset: number;
  suffixDataLength: number;
  suffixDataOffset: number;
  symbolsOffset: number;
};

function convertLogradouroToFsst(source: Uint8Array) {
  const region = sectionRegion(source, 'logradouroDictionary');
  const data = new DataView(source.buffer);
  if (data.getUint8(region.offset + 30) === DICTIONARY_CODEC_FSST) {
    return {
      bytes: source.slice(),
      layout: readFsstLayout(source, region.offset, region.length),
    };
  }

  const values = readPlainDictionary(source, region.offset);
  const idWidth = data.getUint8(region.offset + 28);
  const dictionary = encodeFsstDictionary(values, idWidth);
  return repackDatabase(source, dictionary);
}

function readPlainDictionary(source: Uint8Array, regionOffset: number) {
  const data = new DataView(source.buffer);
  const count = data.getUint32(regionOffset, true);
  const blockCount = data.getUint32(regionOffset + 4, true);
  const blockOffsetsRelative = data.getUint32(regionOffset + 8, true);
  const lengthsRelative = data.getUint32(regionOffset + 12, true);
  const prefixesRelative = data.getUint32(regionOffset + 16, true);
  const suffixDataRelative = data.getUint32(regionOffset + 20, true);
  const values: Uint8Array[] = [];
  for (let block = 0; block < blockCount; block++) {
    let cursor = regionOffset + suffixDataRelative
      + data.getUint32(regionOffset + blockOffsetsRelative + block * 4, true);
    let previous = new Uint8Array();
    const first = block * DICTIONARY_BLOCK_SIZE;
    const last = Math.min(first + DICTIONARY_BLOCK_SIZE, count);
    for (let index = first; index < last; index++) {
      const length = source[regionOffset + lengthsRelative + index] ?? 0;
      const prefix = source[regionOffset + prefixesRelative + index] ?? 0;
      const suffixLength = length - prefix;
      const value = new Uint8Array(length);
      value.set(previous.subarray(0, prefix));
      value.set(source.subarray(cursor, cursor + suffixLength), prefix);
      values.push(value);
      cursor += suffixLength;
      previous = value;
    }
  }
  if (values.length !== count || suffixDataRelative <= 0) {
    throw new Error('Invalid plain dictionary fixture');
  }
  return values;
}

function encodeFsstDictionary(values: Uint8Array[], idWidth: number) {
  const count = values.length;
  const blockCount = Math.ceil(count / DICTIONARY_BLOCK_SIZE);
  const lengthWidth = 2;
  const blockOffsetsRelative = DICTIONARY_HEADER_SIZE;
  const lengthsRelative = blockOffsetsRelative + blockCount * 4;
  const prefixesRelative = lengthsRelative + count * lengthWidth;
  const symbolsRelative = prefixesRelative + count;
  const suffixDataRelative = symbolsRelative + FSST_SYMBOL_TABLE_SIZE;
  const blockOffsets = new Uint32Array(blockCount);
  const lengths = new Uint16Array(count);
  const prefixes = new Uint8Array(count);
  const encodedEntries: Uint8Array[] = [];
  let payloadLength = 0;
  let previous: Uint8Array = new Uint8Array();
  for (const [index, value,] of values.entries()) {
    if (index % DICTIONARY_BLOCK_SIZE === 0) {
      blockOffsets[index >>> 3] = payloadLength;
      previous = new Uint8Array();
    }
    const prefix = commonPrefixLength(previous, value);
    prefixes[index] = prefix;
    const suffix = value.subarray(prefix);
    const encoded = new Uint8Array(suffix.length * 2);
    for (const [byteIndex, byte,] of suffix.entries()) {
      encoded[byteIndex * 2] = 255;
      encoded[byteIndex * 2 + 1] = byte;
    }
    lengths[index] = encoded.length;
    encodedEntries.push(encoded);
    payloadLength += encoded.length;
    previous = value;
  }

  const region = new Uint8Array(suffixDataRelative + payloadLength);
  const data = new DataView(region.buffer);
  data.setUint32(0, count, true);
  data.setUint32(4, blockCount, true);
  data.setUint32(8, blockOffsetsRelative, true);
  data.setUint32(12, lengthsRelative, true);
  data.setUint32(16, prefixesRelative, true);
  data.setUint32(20, suffixDataRelative, true);
  data.setUint32(24, payloadLength, true);
  data.setUint8(28, idWidth);
  data.setUint8(29, DICTIONARY_BLOCK_SHIFT);
  data.setUint8(30, DICTIONARY_CODEC_FSST);
  data.setUint8(31, lengthWidth);
  for (const [index, offset,] of blockOffsets.entries()) {
    data.setUint32(blockOffsetsRelative + index * 4, offset, true);
  }
  for (const [index, length,] of lengths.entries()) {
    data.setUint16(lengthsRelative + index * 2, length, true);
  }
  region.set(prefixes, prefixesRelative);
  let cursor = suffixDataRelative;
  for (const encoded of encodedEntries) {
    region.set(encoded, cursor);
    cursor += encoded.length;
  }
  return region;
}

function repackDatabase(source: Uint8Array, logradouroDictionary: Uint8Array) {
  const sections = BINARY_SECTION_NAMES.map((name) => {
    const region = sectionRegion(source, name);
    return {
      bytes: name === 'logradouroDictionary'
        ? logradouroDictionary
        : source.slice(region.offset, region.offset + region.length),
      name,
    };
  });
  const regions = new Map<string, { length: number; offset: number; }>();
  let cursor = BINARY_DATABASE_HEADER_SIZE;
  for (const section of sections) {
    cursor = align(cursor);
    regions.set(section.name, { length: section.bytes.length, offset: cursor });
    cursor += section.bytes.length;
  }
  const fileSize = align(cursor) + BINARY_DATABASE_CHECKSUM_SIZE;
  const bytes = new Uint8Array(fileSize);
  bytes.set(source.subarray(0, BINARY_DATABASE_HEADER_SIZE));
  const data = new DataView(bytes.buffer);
  data.setUint32(16, fileSize, true);
  for (const [index, section,] of sections.entries()) {
    const region = regions.get(section.name);
    if (!region) {
      throw new Error(`Missing section ${section.name}`);
    }
    const directory = SECTION_TABLE_OFFSET + index * 8;
    data.setUint32(directory, region.offset, true);
    data.setUint32(directory + 4, region.length, true);
    bytes.set(section.bytes, region.offset);
  }
  const region = regions.get('logradouroDictionary');
  if (!region) {
    throw new Error('Missing logradouro dictionary section');
  }
  return {
    bytes,
    layout: readFsstLayout(bytes, region.offset, region.length),
  };
}

function readFsstLayout(bytes: Uint8Array, regionOffset: number, regionLength: number): FsstLayout {
  const data = new DataView(bytes.buffer);
  const count = data.getUint32(regionOffset, true);
  const blockCount = data.getUint32(regionOffset + 4, true);
  const lengthWidth = data.getUint8(regionOffset + 31);
  if (lengthWidth !== 1 && lengthWidth !== 2) {
    throw new Error(`Invalid fixture length width ${lengthWidth}`);
  }
  const lengthsRelative = data.getUint32(regionOffset + 12, true);
  const prefixesRelative = data.getUint32(regionOffset + 16, true);
  return {
    blockCount,
    blockOffsetsOffset: regionOffset + data.getUint32(regionOffset + 8, true),
    count,
    lengthWidth,
    lengthsOffset: regionOffset + lengthsRelative,
    prefixesOffset: regionOffset + prefixesRelative,
    regionLength,
    regionOffset,
    suffixDataLength: data.getUint32(regionOffset + 24, true),
    suffixDataOffset: regionOffset + data.getUint32(regionOffset + 20, true),
    symbolsOffset: regionOffset + prefixesRelative + count,
  };
}

function entryPayloadOffsets(bytes: Uint8Array, layout: FsstLayout) {
  const data = new DataView(bytes.buffer);
  const offsets = new Uint32Array(layout.count);
  for (let block = 0; block < layout.blockCount; block++) {
    let cursor = data.getUint32(layout.blockOffsetsOffset + block * 4, true);
    const first = block * DICTIONARY_BLOCK_SIZE;
    const last = Math.min(first + DICTIONARY_BLOCK_SIZE, layout.count);
    for (let index = first; index < last; index++) {
      offsets[index] = cursor;
      cursor += readCompressedLength(bytes, layout, index);
    }
  }
  return offsets;
}

function readCompressedLength(bytes: Uint8Array, layout: FsstLayout, index: number) {
  const data = new DataView(bytes.buffer);
  return layout.lengthWidth === 1
    ? bytes[layout.lengthsOffset + index] ?? 0
    : data.getUint16(layout.lengthsOffset + index * 2, true);
}

function setCompressedLength(bytes: Uint8Array, layout: FsstLayout, index: number, length: number) {
  if (layout.lengthWidth === 1) {
    bytes[layout.lengthsOffset + index] = length;
  } else {
    new DataView(bytes.buffer).setUint16(layout.lengthsOffset + index * 2, length, true);
  }
}

function sectionRegion(bytes: Uint8Array, name: (typeof BINARY_SECTION_NAMES)[number]) {
  const sectionIndex = BINARY_SECTION_NAMES.indexOf(name);
  const directory = SECTION_TABLE_OFFSET + sectionIndex * 8;
  const data = new DataView(bytes.buffer);
  return {
    length: data.getUint32(directory + 4, true),
    offset: data.getUint32(directory, true),
  };
}

function commonPrefixLength(left: Uint8Array, right: Uint8Array) {
  const limit = Math.min(left.length, right.length);
  let prefix = 0;
  while (prefix < limit && left[prefix] === right[prefix]) {
    prefix++;
  }
  return prefix;
}

function align(value: number) {
  return Math.ceil(value / 8) * 8;
}

function captureError(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected an error');
}
