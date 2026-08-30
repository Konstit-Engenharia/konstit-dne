import {
  afterAll,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DirectoryDneSource,
  resolveBufferedZipDneSource,
  resolveDirectoryDneSource,
  resolveZipDneSource,
  type DneDataSource,
} from '../src/dne-source.ts';
import type { TableDefinition } from '../src/schema.ts';

const workDir = mkdtempSync(join(tmpdir(), 'edne-dne-source-test-'));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const exactTable: TableDefinition = {
  name: 'exact',
  originalName: 'exact',
  fileGlob: 'EXACT.TXT',
  columns: [],
};

const wildcardTable: TableDefinition = {
  name: 'wildcard',
  originalName: 'wildcard',
  fileGlob: 'PART_*.TXT',
  columns: [],
};

const unifiedTable: TableDefinition = {
  name: 'unified',
  originalName: 'unified',
  fileGlob: null,
  unifiedTable: true,
  columns: [],
};

describe('directory DNE source', () => {
  test('sorts and matches files, and decodes Latin-1 lines', async () => {
    const directory = join(workDir, 'directory-source');
    mkdirSync(directory);
    writeFileSync(join(directory, 'PART_Z.TXT'), 'ignored');
    writeFileSync(join(directory, 'PART_A.TXT'), Buffer.from('ol\xe1\r\n\nbeta\nlast\r', 'latin1'));

    const source = new DirectoryDneSource(directory);
    expect(source.matchingFiles('PART_*.TXT')).toEqual(['PART_A.TXT', 'PART_Z.TXT']);
    expect(source.matchingFiles('PART_A.TXT')).toEqual(['PART_A.TXT']);
    expect(source.matchingFiles('ABSENT.TXT')).toEqual([]);
    expect(await lines(source, 'PART_A.TXT')).toEqual(['ol\u00e1', 'beta', 'last']);
  });

  test('resolves direct and Delimitado layouts and rejects incomplete paths', () => {
    const directDirectory = join(workDir, 'direct-layout');
    mkdirSync(directDirectory);
    writeFileSync(join(directDirectory, 'EXACT.TXT'), 'direct');
    expect(resolveDirectoryDneSource(directDirectory, [unifiedTable, exactTable]))
      .toBeInstanceOf(DirectoryDneSource);

    const nestedDirectory = join(workDir, 'nested-layout');
    mkdirSync(join(nestedDirectory, 'Delimitado'), { recursive: true });
    writeFileSync(join(nestedDirectory, 'Delimitado', 'EXACT.TXT'), 'nested');
    expect(resolveDirectoryDneSource(nestedDirectory, [exactTable]))
      .toBeInstanceOf(DirectoryDneSource);

    const incompleteDirectory = join(workDir, 'incomplete-layout');
    mkdirSync(join(incompleteDirectory, 'Delimitado'), { recursive: true });
    expect(resolveDirectoryDneSource(incompleteDirectory, [exactTable])).toBeNull();

    const flatIncompleteDirectory = join(workDir, 'flat-incomplete-layout');
    mkdirSync(flatIncompleteDirectory);
    expect(resolveDirectoryDneSource(flatIncompleteDirectory, [exactTable])).toBeNull();
    expect(resolveDirectoryDneSource(join(workDir, 'not-a-directory'), [exactTable])).toBeNull();
  });
});

describe('buffered ZIP DNE source', () => {
  test('reads stored and deflated entries and supports exact and wildcard matches', async () => {
    const stored = createZip([
      zipEntry('Delimitado/', ''),
      zipEntry('Delimitado/EXACT.TXT', 'first\r\n\nsecond\nlast\r'),
      zipEntry('Delimitado/PART_B.TXT', 'wildcard'),
      zipEntry('unrelated.txt', 'ignored'),
    ], 'zip comment');
    const storedSource = resolveBufferedZipDneSource(
      stored,
      [unifiedTable, exactTable, wildcardTable],
    );

    expect(storedSource.matchingFiles('EXACT.TXT')).toEqual(['EXACT.TXT']);
    expect(storedSource.matchingFiles('PART_*.TXT')).toEqual(['PART_B.TXT']);
    expect(await storedSource.readText?.('EXACT.TXT')).toBe('first\r\n\nsecond\nlast\r');
    expect(await lines(storedSource, 'EXACT.TXT')).toEqual(['first', 'second', 'last']);
    await expectRejects(
      readText(storedSource, 'MISSING.TXT'),
      'DNE data file not found: MISSING.TXT',
    );

    const deflated = createZip([
      zipEntry('dELIMITADO/EXACT.TXT', 'deflated', { compression: 8 }),
    ]);
    const deflatedSource = resolveBufferedZipDneSource(deflated, [exactTable]);
    expect(await deflatedSource.readText?.('EXACT.TXT')).toBe('deflated');
  });

  test('recurses into a case-insensitive nested DNE archive', async () => {
    const inner = createZip([
      zipEntry('Delimitado/EXACT.TXT', 'nested text'),
    ]);
    const outer = createZip([
      zipEntry('downloads/eDNE_Basico_2026.ZIP', inner),
    ]);

    const source = resolveBufferedZipDneSource(outer, [exactTable]);
    expect(await source.readText?.('EXACT.TXT')).toBe('nested text');
  });

  test('validates required entries', () => {
    expect(() => resolveBufferedZipDneSource(createZip([]), [exactTable])).toThrow(
      'ZIP file does not contain DNE Basico files',
    );
    expect(() =>
      resolveBufferedZipDneSource(
        createZip([zipEntry('elsewhere/EXACT.TXT', 'text')]),
        [exactTable],
      )
    ).toThrow('ZIP file does not contain DNE Basico files');
    expect(() =>
      resolveBufferedZipDneSource(
        createZip([zipEntry('Delimitado/EXACT.TXT', 'text')]),
        [exactTable, wildcardTable],
      )
    ).toThrow('DNE data file not found: PART_*.TXT');
  });

  test('rejects invalid end records and central directories', () => {
    expect(() => resolveBufferedZipDneSource(Buffer.alloc(22), [exactTable])).toThrow(
      'Source is not a valid ZIP file',
    );

    const invalidRange = createZip([zipEntry('Delimitado/EXACT.TXT', 'text')]);
    invalidRange.writeUInt32LE(invalidRange.length, findEocd(invalidRange) + 12);
    expect(() => resolveBufferedZipDneSource(invalidRange, [exactTable])).toThrow(
      'Invalid ZIP central directory range',
    );

    const invalidEntry = createZip([zipEntry('Delimitado/EXACT.TXT', 'text')]);
    invalidEntry.writeUInt32LE(0, centralOffset(invalidEntry));
    expect(() => resolveBufferedZipDneSource(invalidEntry, [exactTable])).toThrow(
      'Invalid ZIP central directory entry',
    );

    const invalidEntrySize = createZip([zipEntry('Delimitado/EXACT.TXT', 'text')]);
    invalidEntrySize.writeUInt16LE(0xffff, centralOffset(invalidEntrySize) + 28);
    expect(() => resolveBufferedZipDneSource(invalidEntrySize, [exactTable])).toThrow(
      'Invalid ZIP central directory entry size',
    );
  });

  test('rejects invalid local entries, compression methods, and output sizes', async () => {
    const invalidHeader = createZip([zipEntry('Delimitado/EXACT.TXT', 'text')]);
    invalidHeader.writeUInt32LE(0, 0);
    const invalidHeaderSource = resolveBufferedZipDneSource(invalidHeader, [exactTable]);
    await expectRejects(
      readText(invalidHeaderSource, 'EXACT.TXT'),
      'Invalid ZIP local header for Delimitado/EXACT.TXT',
    );

    const unsupported = createZip([
      zipEntry('Delimitado/EXACT.TXT', 'text', { compression: 99 }),
    ]);
    const unsupportedSource = resolveBufferedZipDneSource(unsupported, [exactTable]);
    await expectRejects(
      readText(unsupportedSource, 'EXACT.TXT'),
      'Unsupported ZIP compression method 99',
    );

    const wrongSize = createZip([
      zipEntry('Delimitado/EXACT.TXT', 'text', {
        compression: 8,
        uncompressedSize: 99,
      }),
    ]);
    const wrongSizeSource = resolveBufferedZipDneSource(wrongSize, [exactTable]);
    await expectRejects(
      readText(wrongSizeSource, 'EXACT.TXT'),
      'Invalid decompressed size for Delimitado/EXACT.TXT',
    );
  });

  test('rejects stored and deflated entries with a CRC32 mismatch', async () => {
    for (const compression of [0, 8]) {
      const invalidCrc = createZip([
        zipEntry('Delimitado/EXACT.TXT', 'corrupt', {
          compression,
          crc32: 0,
        }),
      ]);
      const source = resolveBufferedZipDneSource(invalidCrc, [exactTable]);
      await expectRejects(
        readText(source, 'EXACT.TXT'),
        'CRC32 mismatch for Delimitado/EXACT.TXT',
      );
    }
  });
});

describe('streamed ZIP DNE source', () => {
  test('reads stored and deflated files and reports missing files', async () => {
    const zipPath = writeZip('streamed.zip', [
      zipEntry('Delimitado/EXACT.TXT', 'stored\r\n\nend\r'),
      zipEntry('Delimitado/PART_C.TXT', 'compressed', { compression: 8 }),
    ]);
    const source = await resolveZipDneSource(
      zipPath,
      [exactTable, wildcardTable],
      join(workDir, 'unused-nested.zip'),
    );

    expect(source.matchingFiles('EXACT.TXT')).toEqual(['EXACT.TXT']);
    expect(source.matchingFiles('PART_*.TXT')).toEqual(['PART_C.TXT']);
    expect(await lines(source, 'EXACT.TXT')).toEqual(['stored', 'end']);
    expect(await lines(source, 'PART_C.TXT')).toEqual(['compressed']);
    await expectRejects(
      lines(source, 'MISSING.TXT'),
      'DNE data file not found: MISSING.TXT',
    );
  });

  test('materializes nested ZIPs once and reuses the existing file', async () => {
    const inner = createZip([zipEntry('Delimitado/EXACT.TXT', 'nested streamed')]);
    const outerPath = writeZip('nested-outer.zip', [
      zipEntry('EDNE_BASICO_123.zip', inner, { compression: 8 }),
    ]);
    const nestedPath = join(workDir, 'materialized', 'inner.zip');

    const first = await resolveZipDneSource(outerPath, [exactTable], nestedPath);
    expect(await lines(first, 'EXACT.TXT')).toEqual(['nested streamed']);
    const second = await resolveZipDneSource(outerPath, [exactTable], nestedPath);
    expect(await lines(second, 'EXACT.TXT')).toEqual(['nested streamed']);
  });

  test('cleans a partial nested file when extraction fails', async () => {
    const outerPath = writeZip('broken-nested-outer.zip', [
      zipEntry('eDNE_Basico_broken.zip', 'not a zip', { compression: 99 }),
    ]);
    const directory = join(workDir, 'broken-materialization');
    const nestedPath = join(directory, 'inner.zip');

    await expectRejects(
      resolveZipDneSource(outerPath, [exactTable], nestedPath),
      'Unsupported ZIP compression method 99',
    );
    expect(readdirSync(directory)).toEqual([]);
  });

  test('preserves the extraction error when closing a partial writer also fails', async () => {
    const outerPath = writeZip('writer-close-error-outer.zip', [
      zipEntry('eDNE_Basico_writer_error.zip', 'not a zip', { compression: 99 }),
    ]);
    const nestedPath = join(workDir, 'writer-close-error', 'inner.zip');
    const originalFile = Bun.file;

    Bun.file = ((...args: Parameters<typeof Bun.file>) => {
      const path = String(args[0]);
      if (
        path.startsWith(`${nestedPath}.`)
        && path.endsWith('.tmp')
      ) {
        return {
          writer() {
            return {
              write() {
                return 0;
              },
              end() {
                return Promise.reject(new Error('writer close failed'));
              },
            };
          },
        } as unknown as ReturnType<typeof Bun.file>;
      }
      return originalFile(...args);
    }) as typeof Bun.file;

    try {
      await expectRejects(
        resolveZipDneSource(outerPath, [exactTable], nestedPath),
        'Unsupported ZIP compression method 99',
      );
    } finally {
      Bun.file = originalFile;
    }
  });

  test('rejects short files and invalid central directory ranges', async () => {
    const shortPath = join(workDir, 'short.zip');
    writeFileSync(shortPath, Buffer.alloc(10));
    await expectRejects(
      resolveZipDneSource(shortPath, [exactTable], 'unused'),
      'Source is not a valid ZIP file',
    );

    const invalidRange = createZip([zipEntry('Delimitado/EXACT.TXT', 'text')]);
    invalidRange.writeUInt32LE(invalidRange.length, findEocd(invalidRange) + 12);
    const invalidRangePath = join(workDir, 'invalid-range.zip');
    writeFileSync(invalidRangePath, invalidRange);
    await expectRejects(
      resolveZipDneSource(invalidRangePath, [exactTable], 'unused'),
      'Invalid ZIP central directory range',
    );
  });

  test('rejects invalid local headers and data ranges', async () => {
    const invalidHeader = createZip([zipEntry('Delimitado/EXACT.TXT', 'text')]);
    invalidHeader.writeUInt32LE(0, 0);
    const invalidHeaderPath = join(workDir, 'stream-invalid-header.zip');
    writeFileSync(invalidHeaderPath, invalidHeader);
    const invalidHeaderSource = await resolveZipDneSource(
      invalidHeaderPath,
      [exactTable],
      'unused',
    );
    await expectRejects(
      lines(invalidHeaderSource, 'EXACT.TXT'),
      'Invalid ZIP local header for Delimitado/EXACT.TXT',
    );

    const invalidRange = createZip([
      zipEntry('Delimitado/EXACT.TXT', 'text', { compressedSize: 100_000 }),
    ]);
    const invalidRangePath = join(workDir, 'stream-invalid-data-range.zip');
    writeFileSync(invalidRangePath, invalidRange);
    const invalidRangeSource = await resolveZipDneSource(
      invalidRangePath,
      [exactTable],
      'unused',
    );
    await expectRejects(
      lines(invalidRangeSource, 'EXACT.TXT'),
      'Invalid ZIP data range for Delimitado/EXACT.TXT',
    );
  });

  test('rejects unsupported compression and incorrect decompressed sizes', async () => {
    const unsupportedPath = writeZip('stream-unsupported.zip', [
      zipEntry('Delimitado/EXACT.TXT', 'text', { compression: 99 }),
    ]);
    const unsupported = await resolveZipDneSource(unsupportedPath, [exactTable], 'unused');
    await expectRejects(
      lines(unsupported, 'EXACT.TXT'),
      'Unsupported ZIP compression method 99',
    );

    const wrongSizePath = writeZip('stream-wrong-size.zip', [
      zipEntry('Delimitado/EXACT.TXT', 'text', {
        compression: 8,
        uncompressedSize: 99,
      }),
    ]);
    const wrongSize = await resolveZipDneSource(wrongSizePath, [exactTable], 'unused');
    await expectRejects(
      lines(wrongSize, 'EXACT.TXT'),
      'Invalid decompressed size for Delimitado/EXACT.TXT',
    );
  });

  test('rejects DNE and nested ZIP entries with a CRC32 mismatch', async () => {
    const invalidDnePath = writeZip('stream-invalid-crc.zip', [
      zipEntry('Delimitado/EXACT.TXT', 'corrupt', { crc32: 0 }),
    ]);
    const invalidDne = await resolveZipDneSource(
      invalidDnePath,
      [exactTable],
      'unused',
    );
    await expectRejects(
      lines(invalidDne, 'EXACT.TXT'),
      'CRC32 mismatch for Delimitado/EXACT.TXT',
    );

    const inner = createZip([zipEntry('Delimitado/EXACT.TXT', 'nested')]);
    const invalidNestedPath = writeZip('stream-invalid-nested-crc.zip', [
      zipEntry('eDNE_Basico_2026.zip', inner, { crc32: 0 }),
    ]);
    await expectRejects(
      resolveZipDneSource(
        invalidNestedPath,
        [exactTable],
        join(workDir, 'invalid-crc-inner.zip'),
      ),
      'CRC32 mismatch for eDNE_Basico_2026.zip',
    );
  });
});

async function lines(source: DneDataSource, file: string) {
  const result: string[] = [];
  for await (const line of source.readLines(file)) {
    result.push(line);
  }
  return result;
}

async function readText(source: DneDataSource, file: string) {
  if (!source.readText) {
    throw new Error('Source does not support readText');
  }
  return source.readText(file);
}

async function expectRejects(promise: Promise<unknown>, message: string) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
    return;
  }

  throw new Error('Expected promise to reject');
}

type EntryOptions = {
  compression?: number;
  compressedSize?: number;
  crc32?: number;
  uncompressedSize?: number;
};

type TestZipEntry = {
  name: string;
  content: Buffer;
  compression: number;
  compressedSize?: number;
  crc32?: number;
  uncompressedSize?: number;
};

function zipEntry(
  name: string,
  content: string | Buffer,
  options: EntryOptions = {},
): TestZipEntry {
  return {
    name,
    content: typeof content === 'string' ? Buffer.from(content, 'latin1') : content,
    compression: options.compression ?? 0,
    compressedSize: options.compressedSize,
    crc32: options.crc32,
    uncompressedSize: options.uncompressedSize,
  };
}

function writeZip(name: string, entries: TestZipEntry[]) {
  const path = join(workDir, name);
  writeFileSync(path, createZip(entries));
  return path;
}

function createZip(entries: TestZipEntry[], comment = '') {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const compressed = entry.compression === 8
      ? Buffer.from(Bun.deflateSync(new Uint8Array(entry.content)))
      : entry.content;
    const compressedSize = entry.compressedSize ?? compressed.length;
    const uncompressedSize = entry.uncompressedSize ?? entry.content.length;
    const crc32 = entry.crc32 ?? Bun.hash.crc32(entry.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.compression, 8);
    local.writeUInt32LE(crc32, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.compression, 10);
    central.writeUInt32LE(crc32, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }

  const locals = Buffer.concat(localParts);
  const directory = Buffer.concat(centralParts);
  const zipComment = Buffer.from(comment);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(locals.length, 16);
  eocd.writeUInt16LE(zipComment.length, 20);
  return Buffer.concat([locals, directory, eocd, zipComment]);
}

function findEocd(zip: Buffer) {
  for (let offset = zip.length - 22; offset >= 0; offset--) {
    if (zip.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error('Test ZIP has no end record');
}

function centralOffset(zip: Buffer) {
  return zip.readUInt32LE(findEocd(zip) + 16);
}
