import {
  afterAll,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BINARY_DATABASE_CHECKSUM_SIZE,
  BINARY_DATABASE_HEADER_SIZE,
  BINARY_SECTION_NAMES,
  SECTION_TABLE_OFFSET,
} from '../src/binary-db-format.ts';
import { verifyBinaryDatabaseChecksum } from '../src/binary-db-integrity.ts';
import {
  BINARY_DATABASE_VERSION,
  DneBinaryDatabaseClosedError,
  DneBinaryDatabaseError,
  DneBinaryDatabaseFormatError,
  DneBinaryDatabaseIOError,
  DneBinaryDatabaseReader,
  DneBinaryDatabaseVersionError,
  isBinaryDatabase,
  readBinaryDatabaseMetadata,
} from '../src/binary-db-reader.ts';
import { validateBinaryDatabaseBytes } from '../src/binary-db-validator.ts';
import { buildBinaryDatabase } from '../src/binary-db-writer.ts';
import type { UF } from '../src/types.ts';
import { captureRejection } from './assertions.ts';
import {
  createLocalityFixture,
  fetchDatabase,
} from './helpers.ts';

const workDir = mkdtempSync(join(tmpdir(), 'dne-reader-errors-'));
const binaryPath = join(workDir, 'source.bin');
let original: Uint8Array<ArrayBuffer>;

beforeAll(async () => {
  const sourcePath = join(workDir, 'source');
  const sqlitePath = join(workDir, 'source.db');
  createLocalityFixture(sourcePath);
  fetchDatabase(sqlitePath, sourcePath);
  await buildBinaryDatabase(sqlitePath, binaryPath);
  original = new Uint8Array(await Bun.file(binaryPath).arrayBuffer());
});

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe('binary reader error contract', () => {
  test('wraps failures while inspecting the database signature', async () => {
    const file = Bun.file(binaryPath);
    const failure = new Error('File inspection failed');
    const exists = spyOn(file, 'exists').mockRejectedValue(failure);
    const bunFile = spyOn(Bun, 'file').mockReturnValue(file);
    try {
      expect(await captureRejection(isBinaryDatabase(binaryPath))).toMatchObject({ code: 'IO_ERROR', path: binaryPath, cause: failure });
    } finally {
      bunFile.mockRestore();
      exists.mockRestore();
    }
  });

  test.each(
    [
      [10, 'header size'],
      [22, 'block layout'],
      [24, 'section table'],
    ] as const,
  )('rejects incompatible binary header field %i', async (offset, message) => {
    const bytes = original.slice();
    bytes[offset] = (bytes[offset] ?? 0) ^ 1;
    const path = join(workDir, `invalid-header-${offset}.bin`);
    await Bun.write(path, bytes);
    expect(() => new DneBinaryDatabaseReader(path)).toThrow(message);
  });

  test('wraps malformed metadata after verifying the checksum', async () => {
    const bytes = original.slice();
    const section = SECTION_TABLE_OFFSET + BINARY_SECTION_NAMES.indexOf('metadata') * 8;
    const offset = new DataView(bytes.buffer).getUint32(section, true);
    bytes[offset] = 0;
    const checksumOffset = bytes.length - BINARY_DATABASE_CHECKSUM_SIZE;
    bytes.set(new Bun.CryptoHasher('sha256').update(bytes.subarray(0, checksumOffset)).digest(), checksumOffset);
    const path = join(workDir, 'invalid-metadata.bin');
    await Bun.write(path, bytes);
    const error = captureError(() => new DneBinaryDatabaseReader(path));
    expect(error).toBeInstanceOf(DneBinaryDatabaseFormatError);
    expect(error.message).toBe('Unable to decode binary database');
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });

  test('wraps file access failures with a path, stable code, and original cause', async () => {
    const missing = join(workDir, 'missing.bin');
    const error = captureError(() => new DneBinaryDatabaseReader(missing));
    expect(error).toBeInstanceOf(DneBinaryDatabaseIOError);
    expect(error).toMatchObject({ code: 'IO_ERROR', name: 'DneBinaryDatabaseIOError', path: missing });
    expect(error.cause).toBeInstanceOf(Error);
    expect(await isBinaryDatabase(missing)).toBe(false);
    const metadataError = await readBinaryDatabaseMetadata(missing).catch((cause: unknown) => cause);
    expect(metadataError).toBeInstanceOf(DneBinaryDatabaseIOError);
  });

  test('wraps failures to read embedded database assets', () => {
    const missing = '/$bunfs/root/missing-dne.bin';
    const error = captureError(() => new DneBinaryDatabaseReader(missing));
    expect(error).toBeInstanceOf(DneBinaryDatabaseIOError);
    expect(error).toMatchObject({ code: 'IO_ERROR', path: missing });
    expect(error.cause).toBeInstanceOf(Error);
  });

  test('reads a database without write permissions', async () => {
    const readonlyPath = join(workDir, 'readonly.bin');
    await Bun.write(readonlyPath, original);
    chmodSync(readonlyPath, 0o444);
    const reader = new DneBinaryDatabaseReader(readonlyPath);
    try {
      expect(reader.rowCount()).toBe(20);
      expect(reader.queryCep('21000000')?.bairro).toBe('Centro');
    } finally {
      reader.close();
      chmodSync(readonlyPath, 0o644);
    }
  });

  test('retains its snapshot when the source file is changed or removed', async () => {
    const snapshotPath = join(workDir, 'snapshot.bin');
    await Bun.write(snapshotPath, original);
    const reader = new DneBinaryDatabaseReader(snapshotPath);
    try {
      await Bun.write(snapshotPath, 'replaced');
      expect(reader.queryCep('21000000')?.bairro).toBe('Centro');
      rmSync(snapshotPath);
      expect(reader.queryCep('21000000')?.bairro).toBe('Centro');
      expect(reader.rowCount()).toBe(20);
    } finally {
      reader.close();
    }
  });

  test('reports an empty database as invalid binary content', async () => {
    const emptyPath = join(workDir, 'empty.bin');
    await Bun.write(emptyPath, new Uint8Array());
    const error = captureError(() => new DneBinaryDatabaseReader(emptyPath));
    expect(error).toBeInstanceOf(DneBinaryDatabaseFormatError);
    expect(error).toMatchObject({ code: 'INVALID_FORMAT' });
    expect(error.message).toContain('Binary database header is truncated');
  });

  test.each([false, true])('disposes a reader when leaving a using scope, throwing=%s', (throwing) => {
    const reader = new DneBinaryDatabaseReader(binaryPath);
    const failure = new Error('Scope failed');
    const read = () => {
      using scoped = reader;
      expect(scoped.queryCep('21000000')?.bairro).toBe('Centro');
      if (throwing) {
        throw failure;
      }
    };
    if (throwing) {
      expect(read).toThrow(failure);
    } else {
      read();
    }
    expect(() => reader.queryCep('21000000')).toThrow(DneBinaryDatabaseClosedError);
    expect(reader.rowCount()).toBe(20);
    expect(reader.metadata()).toHaveProperty('loaded_at');
  });

  test('retains parsed metadata and row counts after repeated close and disposal', () => {
    const reader = new DneBinaryDatabaseReader(binaryPath);
    const metadata = reader.metadata();
    const count = reader.rowCount();
    reader.close();
    reader[Symbol.dispose]();
    reader.close();
    reader[Symbol.dispose]();
    expect(reader.metadata()).toEqual(metadata);
    expect(reader.rowCount()).toBe(count);
    const queries = [
      () => reader.queryCep('10000000'),
      () => reader.queryCep('invalid'),
      () => reader.queryMunicipality(3_500_001),
      () => reader.queryMunicipality(NaN),
      () => reader.queryMunicipalityCodesByUf('SP'),
      () => reader.queryMunicipalityCodesByUf('ZZ' as UF),
      () => reader.queryNeighborhood(-1),
      () => reader.queryNeighborhoodByCep('invalid'),
      () => reader.queryNeighborhoodCepRanges(-1),
    ];
    for (const query of queries) {
      const error = captureError(query);
      expect(error).toBeInstanceOf(DneBinaryDatabaseClosedError);
      expect(error.code).toBe('READER_CLOSED');
    }
  });

  test('rejects altered section offsets before decoding the database bytes', async () => {
    const bytes = original.slice();
    const directoryOffset = SECTION_TABLE_OFFSET + BINARY_SECTION_NAMES.indexOf('logradouroDictionary') * 8;
    new DataView(bytes.buffer).setUint32(directoryOffset, 0xffff_ffff, true);
    const path = join(workDir, 'malicious-section-offset.bin');
    await Bun.write(path, bytes);

    const error = captureError(() => new DneBinaryDatabaseReader(path));
    expect(error).toBeInstanceOf(DneBinaryDatabaseFormatError);
    expect(error.message).toContain('SHA-256 checksum mismatch');
  });

  test('rejects footer, padding, and payload byte changes with a checksum error', async () => {
    const paddingOffset = firstPaddingOffset(original);
    const checksumOffset = original.byteLength - BINARY_DATABASE_CHECKSUM_SIZE;
    expect(paddingOffset).toBeLessThan(checksumOffset);
    const flagsDirectory = SECTION_TABLE_OFFSET + BINARY_SECTION_NAMES.indexOf('localidadeFlags') * 8;
    const flagsOffset = new DataView(original.buffer).getUint32(flagsDirectory, true);
    const changes = [
      ['footer', (bytes: Uint8Array) => {
        bytes[checksumOffset] = (bytes[checksumOffset] ?? 0) ^ 1;
      }],
      ['padding', (bytes: Uint8Array) => {
        bytes[paddingOffset] = (bytes[paddingOffset] ?? 0) ^ 1;
      }],
      ['payload', (bytes: Uint8Array) => {
        bytes[flagsOffset] = (bytes[flagsOffset] ?? 0) ^ 1;
      }],
    ] as const;

    for (const [name, mutate,] of changes) {
      const bytes = original.slice();
      mutate(bytes);
      const path = join(workDir, `checksum-${name}.bin`);
      await Bun.write(path, bytes);
      const error = captureError(() => new DneBinaryDatabaseReader(path));
      expect(error).toBeInstanceOf(DneBinaryDatabaseFormatError);
      expect(error.message).toContain('SHA-256 checksum mismatch');
    }
  });

  test('checksums the exact nonzero-offset byte view', () => {
    const padded = new Uint8Array(original.byteLength + 11);
    const view = padded.subarray(5, 5 + original.byteLength);
    view.set(original);
    expect(() => verifyBinaryDatabaseChecksum(view)).not.toThrow();
    padded[0] = 0xff;
    padded[padded.length - 1] = 0xff;
    expect(() => verifyBinaryDatabaseChecksum(view)).not.toThrow();
    view[0] = (view[0] ?? 0) ^ 1;
    expect(() => verifyBinaryDatabaseChecksum(view)).toThrow('SHA-256 checksum mismatch');
  });

  test('reports declared-size mismatches for truncated, extended, and altered files', async () => {
    const extended = new Uint8Array(original.byteLength + 1);
    extended.set(original);
    const declaredSmaller = original.slice();
    new DataView(declaredSmaller.buffer).setUint32(16, original.byteLength - 1, true);
    const cases = [
      ['truncated', original.slice(0, -1)],
      ['extended', extended],
      ['declared-smaller', declaredSmaller],
    ] as const;

    for (const [name, bytes,] of cases) {
      const path = join(workDir, `size-${name}.bin`);
      await Bun.write(path, bytes);
      const error = captureError(() => new DneBinaryDatabaseReader(path));
      expect(error).toBeInstanceOf(DneBinaryDatabaseFormatError);
      expect(error.message).toContain('Binary database size mismatch');
    }
  });

  test('keeps invalid and absent CEPs as normal undefined results', () => {
    const reader = new DneBinaryDatabaseReader(binaryPath);
    try {
      expect(reader.queryCep('invalid')).toBeUndefined();
      expect(reader.queryCep('99999999')).toBeUndefined();
      expect(reader.queryCep('10000-000')?.cep).toBe('10000000');
    } finally {
      reader.close();
    }
  });

  test('exposes actual and supported versions without relying on the error message', async () => {
    const bytes = original.slice();
    new DataView(bytes.buffer).setUint16(8, 1, true);
    const path = join(workDir, 'version.bin');
    await Bun.write(path, bytes);
    expect(await isBinaryDatabase(path)).toBe(true);
    const error = captureError(() => new DneBinaryDatabaseReader(path));
    expect(error).toBeInstanceOf(DneBinaryDatabaseVersionError);
    expect(error).toMatchObject({ code: 'UNSUPPORTED_VERSION', actualVersion: 1, supportedVersion: BINARY_DATABASE_VERSION });
  });

  test('types header, helper-validation, and JSON parsing failures', async () => {
    const badMagic = original.slice();
    badMagic[0] = 0;
    const badWidth = original.slice();
    badWidth[20] = 0;
    const badJson = original.slice();
    const metadataOffset = new DataView(badJson.buffer).getUint32(SECTION_TABLE_OFFSET, true);
    badJson[metadataOffset] = 0;

    for (
      const [name, bytes,] of [
        ['magic', badMagic],
        ['truncated', original.slice(0, 16)],
      ] as const
    ) {
      const path = join(workDir, `${name}.bin`);
      await Bun.write(path, bytes);
      const error = captureError(() => new DneBinaryDatabaseReader(path));
      expect(error).toBeInstanceOf(DneBinaryDatabaseFormatError);
      expect(error.code).toBe('INVALID_FORMAT');
    }

    const widthPath = join(workDir, 'width.bin');
    await Bun.write(widthPath, badWidth);
    const widthError = captureError(() => new DneBinaryDatabaseReader(widthPath));
    expect(widthError).toBeInstanceOf(DneBinaryDatabaseFormatError);
    expect(widthError.message).toContain('SHA-256 checksum mismatch');
    expect(() => validateBinaryDatabaseBytes(badWidth)).toThrow(DneBinaryDatabaseFormatError);

    const jsonError = captureError(() => validateBinaryDatabaseBytes(badJson));
    expect(jsonError).toBeInstanceOf(DneBinaryDatabaseFormatError);
    expect(jsonError.code).toBe('INVALID_FORMAT');
    expect(jsonError.cause).toBeInstanceOf(SyntaxError);
  });

  test('rejects an unsealed payload mutation at open and full validation', async () => {
    const bytes = original.slice();
    const directoryOffset = SECTION_TABLE_OFFSET + BINARY_SECTION_NAMES.indexOf('localidadeFlags') * 8;
    const flagsOffset = new DataView(bytes.buffer).getUint32(directoryOffset, true);
    bytes[flagsOffset] = 255;
    const path = join(workDir, 'row.bin');
    await Bun.write(path, bytes);
    const error = captureError(() => new DneBinaryDatabaseReader(path));
    expect(error).toBeInstanceOf(DneBinaryDatabaseFormatError);
    expect(error.code).toBe('INVALID_FORMAT');
    expect(error.message).toContain('SHA-256 checksum mismatch');
    const validationError = captureError(() => validateBinaryDatabaseBytes(bytes));
    expect(validationError).toBeInstanceOf(DneBinaryDatabaseFormatError);
    expect(validationError.message).toContain('Invalid binary locality run');
  });
});

function captureError(action: () => unknown): DneBinaryDatabaseError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DneBinaryDatabaseError);
    return error as DneBinaryDatabaseError;
  }
  throw new Error('Expected a typed binary database error');
}

function firstPaddingOffset(bytes: Uint8Array) {
  let previousEnd = BINARY_DATABASE_HEADER_SIZE;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < BINARY_SECTION_NAMES.length; index++) {
    const directoryOffset = SECTION_TABLE_OFFSET + index * 8;
    const offset = view.getUint32(directoryOffset, true);
    const length = view.getUint32(directoryOffset + 4, true);
    if (offset > previousEnd) {
      return previousEnd;
    }
    previousEnd = offset + length;
  }
  return previousEnd;
}
