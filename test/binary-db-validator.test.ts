import { Database } from 'bun:sqlite';
import {
  afterAll,
  beforeAll,
  expect,
  test,
} from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeBairroRuns } from '../src/bairro-runs.ts';
import {
  DneBinaryDatabaseError,
  DneBinaryDatabaseFormatError,
} from '../src/binary-db-errors.ts';
import {
  alignBinaryOffset,
  BINARY_DATABASE_CHECKSUM_SIZE,
  BINARY_DATABASE_HEADER_SIZE,
  BINARY_SECTION_NAMES,
  CEP_PREFIX_COUNT,
  DICTIONARY_BLOCK_SHIFT,
  DICTIONARY_BLOCK_SIZE,
  DICTIONARY_HEADER_SIZE,
  readPackedInteger,
  SECTION_TABLE_OFFSET,
  writePacked10,
  writePackedInteger,
  type BinaryRegion,
  type BinarySectionName,
} from '../src/binary-db-format.ts';
import { validateBinaryDatabaseBytes } from '../src/binary-db-validator.ts';
import { buildBinaryDatabase } from '../src/binary-db-writer.ts';
import { readLocalityRunsLayout } from '../src/locality-runs.ts';
import {
  integerBitWidth,
  writePackedBits,
} from '../src/packed-bits.ts';
import {
  createFixture,
  createLocalityFixture,
  fetchDatabase,
} from './helpers.ts';

const workDir = mkdtempSync(join(tmpdir(), 'dne-binary-validator-'));
const generatedDatabasePath = join(workDir, 'generated.db');
const generatedBinaryPath = join(workDir, 'generated.bin');
const localityDatabasePath = join(workDir, 'locality.db');
const localityBinaryPath = join(workDir, 'locality.bin');
let generatedBytes: Uint8Array<ArrayBuffer>;
let localityBytes: Uint8Array<ArrayBuffer>;
let wideBytes: Uint8Array<ArrayBuffer>;

beforeAll(async () => {
  const generatedSourcePath = join(workDir, 'generated-source');
  createFixture(generatedSourcePath, 40);
  fetchDatabase(generatedDatabasePath, generatedSourcePath);
  await buildBinaryDatabase(generatedDatabasePath, generatedBinaryPath);
  generatedBytes = new Uint8Array(await Bun.file(generatedBinaryPath).arrayBuffer());

  const localitySourcePath = join(workDir, 'locality-source');
  createLocalityFixture(localitySourcePath);
  fetchDatabase(localityDatabasePath, localitySourcePath);
  await buildBinaryDatabase(localityDatabasePath, localityBinaryPath);
  localityBytes = new Uint8Array(await Bun.file(localityBinaryPath).arrayBuffer());

  const wideSourcePath = join(workDir, 'wide-source');
  const wideDatabasePath = join(workDir, 'wide.db');
  const wideBinaryPath = join(workDir, 'wide.bin');
  createFixture(wideSourcePath, 300);
  fetchDatabase(wideDatabasePath, wideSourcePath);
  const wideDatabase = new Database(wideDatabasePath);
  try {
    wideDatabase.run('UPDATE dne SET complemento = cep');
  } finally {
    wideDatabase.close();
  }
  await buildBinaryDatabase(wideDatabasePath, wideBinaryPath);
  wideBytes = new Uint8Array(await Bun.file(wideBinaryPath).arrayBuffer());
});

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

test('accepts generated v5 fixtures and ignores the reserved checksum footer', () => {
  expect(() => validateBinaryDatabaseBytes(generatedBytes)).not.toThrow();
  const bytes = generatedBytes.slice();
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
  expect(() => validateBinaryDatabaseBytes(bytes)).not.toThrow();
});

test('rejects non-byte input and truncated headers', () => {
  expectInvalid(null as unknown as Uint8Array, 'must be a Uint8Array');
  expectInvalid(new Uint8Array(BINARY_DATABASE_HEADER_SIZE), 'header is truncated');
});

test.each(
  [
    ['magic', 0, 0, 1, 'magic'],
    ['version', 8, 0, 2, 'version'],
    ['header size', 10, 0, 2, 'header size'],
    ['block layout', 22, 0, 1, 'block layout'],
    ['section count', 24, 0, 2, 'section table'],
    ['file size', 16, 0, 4, 'size mismatch'],
    ['no rows', 12, 0, 4, 'must contain rows'],
    ['no municipalities', 28, 0, 4, 'must contain rows'],
    ['row capacity', 12, 256, 4, 'row count does not fit'],
    ['municipality capacity', 28, 256, 4, 'municipality count does not fit'],
    ['noncanonical width', 20, 2, 1, 'noncanonical integer width'],
  ] as const,
)('rejects invalid header %s', (_name, offset, value, width, message) => {
  const bytes = generatedBytes.slice();
  const view = new DataView(bytes.buffer);
  if (width === 4) {
    view.setUint32(offset, value, true);
  } else if (width === 2) {
    view.setUint16(offset, value, true);
  } else {
    view.setUint8(offset, value);
  }
  expectInvalid(bytes, message);
});

test('rejects unaligned payloads and invalid section boundaries', () => {
  const unaligned = generatedBytes.slice(0, -1);
  new DataView(unaligned.buffer).setUint32(16, unaligned.length, true);
  expectInvalid(unaligned, 'invalid alignment');
  for (const [offset, message,] of [[0, 'outside the payload'], [BINARY_DATABASE_HEADER_SIZE + 1, 'unaligned']] as const) {
    const bytes = generatedBytes.slice();
    new DataView(bytes.buffer).setUint32(SECTION_TABLE_OFFSET, offset, true);
    expectInvalid(bytes, message);
  }
});

test.each(
  [
    ['truncated dictionary', 'bairroDictionary', 31, 'dictionary is truncated'],
    ['truncated neighborhoods', 'bairros', 15, 'table is truncated'],
    ['prefix directory', 'cepPrefixOffsets', 1, 'invalid length'],
  ] as const,
)('rejects a %s section', (_name, name, length, message) => {
  const region = section(generatedBytes, name);
  expectInvalid(replaceSection(generatedBytes, name, generatedBytes.slice(region.offset, region.offset + length)), message);
});

test.each(
  [
    ['block size', 29, 0, 1, 'dictionary block size'],
    ['block count', 4, 0, 4, 'invalid count or id width'],
    ['layout', 8, 0, 4, 'invalid layout'],
  ] as const,
)('rejects invalid plain dictionary %s', (_name, field, value, width, message) => {
  const bytes = generatedBytes.slice();
  const dictionary = dictionaryInfo(bytes, 'municipioDictionary');
  const view = new DataView(bytes.buffer);
  if (width === 1) {
    view.setUint8(dictionary.offset + field, value);
  } else {
    view.setUint32(dictionary.offset + field, value, true);
  }
  expectInvalid(bytes, message);
});

test.each(
  [
    ['first block', (bytes: Uint8Array, dictionary: ReturnType<typeof dictionaryInfo>) => {
      new DataView(bytes.buffer).setUint32(dictionary.blockOffsetsOffset, 1, true);
    }, 'invalid first block offset'],
    ['block beyond payload', (bytes: Uint8Array, dictionary: ReturnType<typeof dictionaryInfo>) => {
      new DataView(bytes.buffer).setUint32(dictionary.blockOffsetsOffset + 4, dictionary.suffixDataLength + 1, true);
    }, 'invalid block offsets'],
    ['length shorter than prefix', (bytes: Uint8Array, dictionary: ReturnType<typeof dictionaryInfo>) => {
      bytes[dictionary.lengthsOffset + 1] = 0;
    }, 'dictionary length'],
    ['suffix beyond block', (bytes: Uint8Array, dictionary: ReturnType<typeof dictionaryInfo>) => {
      bytes[dictionary.lengthsOffset] = 255;
    }, 'dictionary suffix'],
  ] as const,
)('rejects plain dictionary %s corruption', (_name, mutate, message) => {
  const bytes = generatedBytes.slice();
  mutate(bytes, dictionaryInfo(bytes, 'municipioDictionary'));
  expectInvalid(bytes, message);
});

test('rejects invalid UF names', () => {
  const bytes = generatedBytes.slice();
  const entry = plainDictionarySuffixes(bytes, 'ufDictionary').at(-1);
  if (!entry) {
    throw new Error('The generated fixture must contain a UF dictionary entry');
  }
  bytes.set(new TextEncoder().encode('ZZ'), entry.offset);
  expectInvalid(bytes, 'Invalid binary UF dictionary entry');
});

test('rejects empty neighborhood and municipality names', () => {
  const emptyDictionary = new Uint8Array(DICTIONARY_HEADER_SIZE + 6);
  const view = new DataView(emptyDictionary.buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, 1, true);
  for (const [field, value,] of [[8, 32], [12, 36], [16, 37], [20, 38]] as const) {
    view.setUint32(field, value, true);
  }
  view.setUint8(28, 1);
  view.setUint8(29, DICTIONARY_BLOCK_SHIFT);
  expectInvalid(replaceSection(localityBytes, 'bairroDictionary', emptyDictionary), 'neighborhood has an empty name');
  const bytes = replaceSection(localityBytes, 'municipioDictionary', emptyDictionary);
  bytes[section(bytes, 'municipalities').offset + 3] = 1;
  expectInvalid(bytes, 'municipality has an empty name');
  const trailingPayload = new Uint8Array(emptyDictionary.length + 1);
  trailingPayload.set(emptyDictionary);
  new DataView(trailingPayload.buffer).setUint32(24, 1, true);
  expectInvalid(replaceSection(localityBytes, 'bairroDictionary', trailingPayload), 'dictionary block length mismatch');
});

test.each(
  [
    ['neighborhood ID', 'bairros', 16, 0, 'neighborhood record'],
    ['IBGE code', 'municipalities', 0, 0, 'IBGE municipality code'],
    ['municipality name ID', 'municipalities', 3, 0, 'municipality record'],
    ['first range offset', 'bairroFaixaOffsets', 0, 1, 'range layout'],
    ['range boundary', 'bairroFaixaOffsets', 4, 255, 'range offsets'],
    ['reversed range', 'bairroFaixas', 4, 0, 'CEP range'],
  ] as const,
)('rejects invalid %s', (_name, name, field, value, message) => {
  const bytes = localityBytes.slice();
  new DataView(bytes.buffer).setUint32(section(bytes, name).offset + field, value, true);
  expectInvalid(bytes, message);
});

test('rejects unreferenced neighborhood ranges', () => {
  const bytes = localityBytes.slice();
  const offsets = section(bytes, 'bairroFaixaOffsets');
  bytes.fill(0, offsets.offset, offsets.offset + offsets.length);
  expectInvalid(bytes, 'Unreferenced binary neighborhood CEP ranges');
});

test('rejects sparse columns with too few IDs or an invalid final rank', () => {
  const region = section(generatedBytes, 'complementoIds');
  const shortened = generatedBytes.slice(region.offset, region.offset + region.length - 1);
  expectInvalid(replaceSection(generatedBytes, 'complementoIds', shortened), 'outside the column');
  const bytes = generatedBytes.slice();
  const ranks = section(bytes, 'complementoRanks');
  new DataView(bytes.buffer).setUint32(ranks.offset + ranks.length - 4, 0, true);
  expectInvalid(bytes, 'invalid final rank');
});

test('rejects CEP suffix padding', () => {
  const bytes = generatedBytes.slice();
  const suffixes = section(bytes, 'cepSuffixes');
  bytes[suffixes.offset + suffixes.length - 1] = (bytes[suffixes.offset + suffixes.length - 1] ?? 0) | 0x80;
  expectInvalid(bytes, 'CEP suffix padding');
});

test('rejects partial two-byte sparse IDs', () => {
  const region = section(wideBytes, 'complementoIds');
  expect(dictionaryInfo(wideBytes, 'complementoDictionary').idWidth).toBe(2);
  expectInvalid(
    replaceSection(wideBytes, 'complementoIds', wideBytes.slice(region.offset, region.offset + region.length - 1)),
    'sparse ids have an invalid length',
  );
});

test('rejects neighborhood IDs stored with a noncanonical width', () => {
  const bytes = generatedBytes.slice();
  const region = section(bytes, 'bairros');
  const view = new DataView(bytes.buffer);
  const count = view.getUint32(region.offset, true);
  const width = view.getUint8(region.offset + 4) as 1 | 2 | 3 | 4;
  const recordWidth = (region.length - 16) / count;
  expect(width).toBe(3);
  for (let index = 0; index < count; index++) {
    writePackedInteger(bytes, region.offset + 16 + index * recordWidth, index + 1, width);
  }
  expectInvalid(bytes, 'neighborhood table uses a noncanonical integer width');
});

test('validates nonzero neighborhood low bits and rejects their padding', () => {
  const rowCount = new DataView(generatedBytes.buffer).getUint32(12, true);
  const ids = Uint8Array.from({ length: rowCount }, (_, row) => row < 3 ? 0 : row < 7 ? 1 : 0);
  const runs = encodeBairroRuns(ids, rowCount, 1);
  const valid = replaceSection(generatedBytes, 'bairroIds', runs);
  const municipalRuns = section(valid, 'municipalityIds');
  const data = new DataView(valid.buffer);
  const localityRuns = readLocalityRunsLayout(data, municipalRuns, rowCount);
  // Keep the synthetic neighborhood run in the same UF as every municipality.
  for (let index = 0; index < localityRuns.count; index++) {
    writePackedInteger(valid, localityRuns.idsOffset + index, 1, 1);
  }
  const flags = section(valid, 'localidadeFlags');
  for (let index = 0; index < flags.length; index++) {
    valid[flags.offset + index] = index % 2;
  }
  expect(() => validateBinaryDatabaseBytes(valid)).not.toThrow();
  const region = section(valid, 'bairroIds');
  const lowBits = valid[region.offset + 4] ?? 0;
  const usedBits = data.getUint32(region.offset, true) * lowBits;
  expect(usedBits % 8).not.toBe(0);
  valid[region.offset + 8 + Math.floor(usedBits / 8)] = (valid[region.offset + 8 + Math.floor(usedBits / 8)] ?? 0) | (1 << (usedBits & 7));
  expectInvalid(valid, 'neighborhood run low-bit padding');
});

test.each(
  [
    ['BOM', '\ufeff{}', 'must not contain a UTF-8 BOM'],
    ['malformed JSON', '{', 'invalid JSON or UTF-8'],
    ['array', '[]', 'must be an object'],
    ['null', 'null', 'must be an object'],
    ['non-string value', '{"version":5}', 'values must be strings'],
  ] as const,
)('rejects metadata containing %s', (_name, value, message) => {
  expectInvalid(replaceSection(generatedBytes, 'metadata', new TextEncoder().encode(value)), message);
});

test.each(
  [
    ['suffix 1000', (bytes: Uint8Array) => setPacked10(bytes, 'cepSuffixes', 0, 1000)],
    ['suffix order', (bytes: Uint8Array) => setPacked10(bytes, 'cepSuffixes', 1, 0)],
    ['first prefix boundary', (bytes: Uint8Array) => {
      const region = section(bytes, 'cepPrefixOffsets');
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint8(region.offset, 1);
    }],
    ['final prefix boundary', (bytes: Uint8Array) => {
      const region = section(bytes, 'cepPrefixOffsets');
      const width = bytes[20] as 1 | 2 | 3 | 4;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const rowCount = view.getUint32(12, true);
      for (let prefix = 0; prefix <= CEP_PREFIX_COUNT; prefix++) {
        const offset = region.offset + prefix * width;
        if (readPackedInteger(view, offset, width) === rowCount) {
          writePackedInteger(bytes, offset, rowCount - 1, width);
        }
      }
    }],
  ] as const,
)('rejects CEP %s corruption', (_name, mutate) => {
  const bytes = generatedBytes.slice();
  mutate(bytes);
  expectInvalid(bytes);
});

test.each(
  [
    ['out of range', (bytes: Uint8Array) => {
      const dictionary = dictionaryInfo(bytes, 'logradouroDictionary');
      const width = integerBitWidth(dictionary.count);
      setPackedBits(bytes, 'logradouroIds', 0, width, dictionary.count + 1);
    }],
    ['padding', (bytes: Uint8Array) => {
      const region = section(bytes, 'logradouroIds');
      bytes[region.offset + region.length - 1] = (bytes[region.offset + region.length - 1] ?? 0) | 0x04;
    }],
  ] as const,
)('rejects packed logradouro ID %s corruption', (_name, mutate) => {
  const bytes = generatedBytes.slice();
  mutate(bytes);
  expectInvalid(bytes);
});

test.each(
  [
    ['rank mismatch', (bytes: Uint8Array) => {
      const region = section(bytes, 'complementoRanks');
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(region.offset, 1, true);
    }],
    ['zero dense ID', (bytes: Uint8Array) => {
      const region = section(bytes, 'complementoIds');
      bytes[region.offset] = 0;
    }],
    ['bitmap padding', (bytes: Uint8Array) => {
      const region = section(bytes, 'complementoBitmap');
      bytes[region.offset + region.length - 1] = (bytes[region.offset + region.length - 1] ?? 0) | 0x80;
    }],
  ] as const,
)('rejects sparse column %s corruption', (_name, mutate) => {
  const bytes = generatedBytes.slice();
  mutate(bytes);
  expectInvalid(bytes);
});

test('rejects a required municipality reference of zero', () => {
  const bytes = localityBytes.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const region = section(bytes, 'municipalityIds');
  const layout = readLocalityRunsLayout(view, region, view.getUint32(12, true));
  writePackedInteger(bytes, layout.idsOffset, 0, bytes[21] as 1 | 2 | 3 | 4);
  expectInvalid(bytes);
});

test('rejects a noncanonical UF dictionary value', () => {
  const bytes = localityBytes.slice();
  const entry = plainDictionarySuffixes(bytes, 'ufDictionary')[0];
  if (!entry || entry.length < 2) {
    throw new Error('The locality fixture must contain a two-byte UF entry');
  }
  bytes[entry.offset] = 0x73;
  expectInvalid(bytes);
});

test('rejects an IBGE code and municipality UF mismatch', () => {
  const bytes = generatedBytes.slice();
  const municipality = section(bytes, 'municipalities');
  const municipioWidth = dictionaryInfo(bytes, 'municipioDictionary').idWidth;
  const ufWidth = dictionaryInfo(bytes, 'ufDictionary').idWidth;
  writePackedInteger(bytes, municipality.offset + 3 + municipioWidth, 2, ufWidth);
  expectInvalid(bytes);
});

test('rejects a neighborhood and municipality UF mismatch', () => {
  const bytes = generatedBytes.slice();
  const bairros = section(bytes, 'bairros');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const originalIdWidth = view.getUint8(bairros.offset + 4);
  const localidadeIdWidth = view.getUint8(bairros.offset + 5);
  const bairroWidth = dictionaryInfo(bytes, 'bairroDictionary').idWidth;
  const abbreviationWidth = dictionaryInfo(bytes, 'bairroAbreviadoDictionary').idWidth;
  const ufWidth = dictionaryInfo(bytes, 'ufDictionary').idWidth;
  const ufOffset = bairros.offset + 16 + originalIdWidth + localidadeIdWidth + bairroWidth + abbreviationWidth;
  writePackedInteger(bytes, ufOffset, 2, ufWidth);
  expectInvalid(bytes);
});

test('rejects a fallback locality name attached to a municipality row', () => {
  const bytes = localityBytes.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rowCount = view.getUint32(12, true);
  const runsRegion = section(bytes, 'municipalityIds');
  const runs = readLocalityRunsLayout(view, runsRegion, rowCount);
  const flags = section(bytes, 'localidadeFlags');
  const targetRow = 1;
  let run = 0;
  while (run + 1 < view.getUint32(runsRegion.offset, true) && view.getUint32(runs.startsOffset + (run + 1) * 4, true) <= targetRow) {
    run++;
  }
  bytes[flags.offset + run] = 0;
  expectInvalid(bytes);
});

test('rejects duplicate adjacent locality runs', () => {
  const bytes = localityBytes.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const runsRegion = section(bytes, 'municipalityIds');
  const runs = readLocalityRunsLayout(view, runsRegion, view.getUint32(12, true));
  const flags = section(bytes, 'localidadeFlags');
  const firstRun = 1;
  const secondRun = 2;
  expect(view.getUint8(runs.idsOffset + firstRun)).toBe(view.getUint8(runs.idsOffset + secondRun));
  bytes[flags.offset + secondRun] = bytes[flags.offset + firstRun] ?? 0;
  expectInvalid(bytes);
});

test('validates every plain dictionary entry even after its final municipality reference is removed', () => {
  const bytes = generatedBytes.slice();
  const dictionary = dictionaryInfo(bytes, 'municipioDictionary');
  const municipality = section(bytes, 'municipalities');
  const ufWidth = dictionaryInfo(bytes, 'ufDictionary').idWidth;
  const recordWidth = 3 + dictionary.idWidth + ufWidth;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let removed = false;
  for (let index = 0; index < view.getUint32(28, true); index++) {
    const offset = municipality.offset + index * recordWidth + 3;
    if (readPackedInteger(view, offset, dictionary.idWidth) === dictionary.count) {
      writePackedInteger(bytes, offset, 1, dictionary.idWidth);
      removed = true;
    }
  }
  expect(removed).toBe(true);
  expect(() => validateBinaryDatabaseBytes(bytes)).not.toThrow();
  const entry = plainDictionarySuffixes(bytes, 'municipioDictionary').at(-1);
  if (!entry || entry.length === 0) {
    throw new Error('The generated municipality dictionary must have a final suffix');
  }
  bytes[entry.offset] = 0xff;
  expectInvalid(bytes, 'Invalid UTF-8');
});

test('rejects an unsorted plain dictionary', () => {
  const bytes = generatedBytes.slice();
  const entries = plainDictionarySuffixes(bytes, 'municipioDictionary');
  const entry = entries[0];
  if (!entry || entry.length === 0) {
    throw new Error('The generated municipality dictionary must have a first suffix');
  }
  bytes[entry.offset + entry.length - 1] = 0x7a;
  expectInvalid(bytes);
});

test('rejects an impossible plain dictionary prefix', () => {
  const bytes = generatedBytes.slice();
  const dictionary = dictionaryInfo(bytes, 'municipioDictionary');
  bytes[dictionary.prefixesOffset + 1] = 0xff;
  expectInvalid(bytes);
});

test('rejects plain dictionary blocks that do not consume their payload', () => {
  const bytes = generatedBytes.slice();
  const dictionary = dictionaryInfo(bytes, 'municipioDictionary');
  expect(dictionary.blockCount).toBeGreaterThan(1);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
    dictionary.blockOffsetsOffset + 4,
    dictionary.suffixDataLength,
    true,
  );
  expectInvalid(bytes);
});

test('rejects an empty dictionary with a nonempty payload', () => {
  const bytes = localityBytes.slice();
  const dictionary = dictionaryInfo(bytes, 'bairroAbreviadoDictionary');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(dictionary.offset, 0, true);
  view.setUint32(dictionary.offset + 4, 0, true);
  for (const field of [8, 12, 16, 20]) {
    view.setUint32(dictionary.offset + field, 32, true);
  }
  view.setUint32(dictionary.offset + 24, dictionary.region.length - 32, true);
  expectInvalid(bytes, 'dictionary has unexpected payload');
});

test('rejects nonzero header reserved bytes and payload bytes at the exact footer boundary', () => {
  const reserved = localityBytes.slice();
  reserved[26] = 1;
  expectInvalid(reserved);

  const payload = localityBytes.slice();
  payload[payload.length - BINARY_DATABASE_CHECKSUM_SIZE - 1] = 1;
  expectInvalid(payload);
});

test('rejects an extra aligned zero gap before the checksum footer', () => {
  const originalEnd = localityBytes.length - BINARY_DATABASE_CHECKSUM_SIZE;
  const bytes = new Uint8Array(localityBytes.length + 8);
  bytes.set(localityBytes.subarray(0, originalEnd));
  bytes.set(localityBytes.subarray(originalEnd), originalEnd + 8);
  new DataView(bytes.buffer).setUint32(16, bytes.length, true);
  expectInvalid(bytes, 'footer is not after aligned section data');
});

test('does not replace an existing destination or publish a new file after semantic validation fails', async () => {
  const database = new Database(localityDatabasePath);
  try {
    database.run('UPDATE bairros SET uf = ? WHERE bairro_id = ?', ['BA', 11]);
  } finally {
    database.close();
  }

  const existingPath = join(workDir, 'existing-destination.bin');
  const newPath = join(workDir, 'unpublished.bin');
  await Bun.write(existingPath, 'keep this destination');
  await expectBuildFailure(localityDatabasePath, existingPath);
  expect(readFileSync(existingPath, 'utf8')).toBe('keep this destination');
  await expectBuildFailure(localityDatabasePath, newPath);
  expect(existsSync(newPath)).toBe(false);
});

function expectInvalid(bytes: Uint8Array, message?: string) {
  const error = captureError(() => validateBinaryDatabaseBytes(bytes));
  expect(error).toBeInstanceOf(DneBinaryDatabaseFormatError);
  expect(error.code).toBe('INVALID_FORMAT');
  if (message) {
    expect(error.message).toContain(message);
  }
}

function captureError(action: () => unknown): DneBinaryDatabaseError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DneBinaryDatabaseError);
    return error as DneBinaryDatabaseError;
  }
  throw new Error('Expected a typed binary database error');
}

async function expectBuildFailure(databasePath: string, outputPath: string) {
  try {
    await buildBinaryDatabase(databasePath, outputPath);
  } catch (error) {
    expect(error).toBeInstanceOf(DneBinaryDatabaseError);
    expect((error as DneBinaryDatabaseError).code).toBe('INVALID_FORMAT');
    return;
  }
  throw new Error('Expected binary generation to fail validation');
}

function section(bytes: Uint8Array, name: BinarySectionName): BinaryRegion {
  const index = BINARY_SECTION_NAMES.indexOf(name);
  const directoryOffset = SECTION_TABLE_OFFSET + index * 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    offset: view.getUint32(directoryOffset, true),
    length: view.getUint32(directoryOffset + 4, true),
  };
}

function replaceSection(source: Uint8Array, name: BinarySectionName, replacement: Uint8Array): Uint8Array<ArrayBuffer> {
  const sections = BINARY_SECTION_NAMES.map((sectionName) => {
    const region = section(source, sectionName);
    return sectionName === name ? replacement : source.subarray(region.offset, region.offset + region.length);
  });
  let fileSize = BINARY_DATABASE_HEADER_SIZE;
  for (const bytes of sections) {
    fileSize = alignBinaryOffset(fileSize) + bytes.length;
  }
  fileSize = alignBinaryOffset(fileSize) + BINARY_DATABASE_CHECKSUM_SIZE;
  const bytes = new Uint8Array(fileSize);
  bytes.set(source.subarray(0, BINARY_DATABASE_HEADER_SIZE));
  const data = new DataView(bytes.buffer);
  data.setUint32(16, fileSize, true);
  let offset = BINARY_DATABASE_HEADER_SIZE;
  for (const [index, payload,] of sections.entries()) {
    offset = alignBinaryOffset(offset);
    data.setUint32(SECTION_TABLE_OFFSET + index * 8, offset, true);
    data.setUint32(SECTION_TABLE_OFFSET + index * 8 + 4, payload.length, true);
    bytes.set(payload, offset);
    offset += payload.length;
  }
  return bytes;
}

function dictionaryInfo(bytes: Uint8Array, name: BinarySectionName) {
  const region = section(bytes, name);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const encodedWidth = view.getUint8(region.offset + 31);
  const count = view.getUint32(region.offset, true);
  return {
    blockCount: view.getUint32(region.offset + 4, true),
    blockOffsetsOffset: region.offset + view.getUint32(region.offset + 8, true),
    count,
    idWidth: view.getUint8(region.offset + 28) as 1 | 2 | 3 | 4,
    lengthWidth: encodedWidth === 2 ? 2 : 1,
    lengthsOffset: region.offset + view.getUint32(region.offset + 12, true),
    offset: region.offset,
    prefixesOffset: region.offset + view.getUint32(region.offset + 16, true),
    region,
    suffixDataLength: view.getUint32(region.offset + 24, true),
    suffixDataOffset: region.offset + view.getUint32(region.offset + 20, true),
  };
}

function plainDictionarySuffixes(bytes: Uint8Array, name: BinarySectionName) {
  const dictionary = dictionaryInfo(bytes, name);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: { offset: number; length: number; }[] = [];
  for (let block = 0; block < dictionary.blockCount; block++) {
    let cursor = dictionary.suffixDataOffset + view.getUint32(dictionary.blockOffsetsOffset + block * 4, true);
    const blockStart = block * DICTIONARY_BLOCK_SIZE;
    const blockEnd = Math.min(dictionary.count, blockStart + DICTIONARY_BLOCK_SIZE);
    for (let index = blockStart; index < blockEnd; index++) {
      const length = dictionary.lengthWidth === 1
        ? bytes[dictionary.lengthsOffset + index] ?? 0
        : view.getUint16(dictionary.lengthsOffset + index * 2, true);
      const prefix = bytes[dictionary.prefixesOffset + index] ?? 0;
      const suffixLength = length - prefix;
      entries.push({ length: suffixLength, offset: cursor });
      cursor += suffixLength;
    }
  }
  return entries;
}

function setPacked10(bytes: Uint8Array, name: BinarySectionName, index: number, value: number) {
  const region = section(bytes, name);
  const bitOffset = index * 10;
  const target = bytes.subarray(region.offset, region.offset + region.length);
  for (let bit = 0; bit < 10; bit++) {
    const position = bitOffset + bit;
    target[position >>> 3] = (target[position >>> 3] ?? 0) & ~(1 << (position & 7));
  }
  writePacked10(target, index, value);
}

function setPackedBits(bytes: Uint8Array, name: BinarySectionName, index: number, width: number, value: number) {
  const region = section(bytes, name);
  const target = bytes.subarray(region.offset, region.offset + region.length);
  const bitOffset = index * width;
  for (let bit = 0; bit < width; bit++) {
    const position = bitOffset + bit;
    target[position >>> 3] = (target[position >>> 3] ?? 0) & ~(1 << (position & 7));
  }
  writePackedBits(target, index, width, value);
}
