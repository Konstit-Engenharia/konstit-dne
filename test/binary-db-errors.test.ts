import {
  afterAll,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BINARY_SECTION_NAMES,
  SECTION_TABLE_OFFSET,
} from '../src/binary-db-format.ts';
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
import { buildBinaryDatabase } from '../src/binary-db-writer.ts';
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

  test('retains parsed metadata and row counts after an idempotent close', () => {
    const reader = new DneBinaryDatabaseReader(binaryPath);
    const metadata = reader.metadata();
    const count = reader.rowCount();
    reader.close();
    reader.close();
    expect(reader.metadata()).toEqual(metadata);
    expect(reader.rowCount()).toBe(count);
    for (const cep of ['10000000', 'invalid']) {
      const error = captureError(() => reader.queryCep(cep));
      expect(error).toBeInstanceOf(DneBinaryDatabaseClosedError);
      expect(error.code).toBe('READER_CLOSED');
    }
  });

  test('keeps invalid and absent CEPs as normal null results', () => {
    const reader = new DneBinaryDatabaseReader(binaryPath);
    try {
      expect(reader.queryCep('invalid')).toBeNull();
      expect(reader.queryCep('99999999')).toBeNull();
      expect(reader.queryCep('10000-000')?.cep).toBe('10000000');
    } finally {
      reader.close();
    }
  });

  test('exposes actual and supported versions without relying on the error message', async () => {
    const bytes = original.slice();
    new DataView(bytes.buffer).setUint16(8, 2, true);
    const path = join(workDir, 'version.bin');
    await Bun.write(path, bytes);
    expect(await isBinaryDatabase(path)).toBe(true);
    const error = captureError(() => new DneBinaryDatabaseReader(path));
    expect(error).toBeInstanceOf(DneBinaryDatabaseVersionError);
    expect(error).toMatchObject({ code: 'UNSUPPORTED_VERSION', actualVersion: 2, supportedVersion: BINARY_DATABASE_VERSION });
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
      const [name, bytes, causeType,] of [
        ['magic', badMagic, null],
        ['truncated', original.slice(0, 16), null],
        ['width', badWidth, Error],
        ['json', badJson, SyntaxError],
      ] as const
    ) {
      const path = join(workDir, `${name}.bin`);
      await Bun.write(path, bytes);
      const error = captureError(() => new DneBinaryDatabaseReader(path));
      expect(error).toBeInstanceOf(DneBinaryDatabaseFormatError);
      expect(error.code).toBe('INVALID_FORMAT');
      if (causeType) {
        expect(error.cause).toBeInstanceOf(causeType);
      }
    }
  });

  test('types failures found while decoding an individual record', async () => {
    const bytes = original.slice();
    const directoryOffset = SECTION_TABLE_OFFSET + BINARY_SECTION_NAMES.indexOf('localidadeFlags') * 8;
    const flagsOffset = new DataView(bytes.buffer).getUint32(directoryOffset, true);
    bytes[flagsOffset] = 255;
    const path = join(workDir, 'row.bin');
    await Bun.write(path, bytes);
    const reader = new DneBinaryDatabaseReader(path);
    try {
      const error = captureError(() => reader.queryCep('10000000'));
      expect(error).toBeInstanceOf(DneBinaryDatabaseFormatError);
      expect(error.code).toBe('INVALID_FORMAT');
    } finally {
      reader.close();
    }
  });

  test('wraps native decoding exceptions without losing their cause', () => {
    const reader = new DneBinaryDatabaseReader(binaryPath);
    const cause = new RangeError('Native view access failed');
    const nativeRead = spyOn(DataView.prototype, 'getUint8').mockImplementationOnce(() => {
      throw cause;
    });
    let error: unknown;
    try {
      reader.queryCep('10000000');
    } catch (caught) {
      error = caught;
    } finally {
      nativeRead.mockRestore();
      reader.close();
    }
    expect(error).toBeInstanceOf(DneBinaryDatabaseFormatError);
    expect(error).toMatchObject({ code: 'INVALID_FORMAT', cause });
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
