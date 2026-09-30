import {
  mkdir,
  rename,
  rm,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  join,
} from 'node:path';
import {
  getTableFilesGlob,
  type TableDefinition,
} from './schema.ts';

const DELIMITED_SUBDIR = 'Delimitado';
const LATIN1_ENCODING = 'latin1' as ConstructorParameters<typeof TextDecoder>[0];
const LATIN1_DECODER = new TextDecoder(LATIN1_ENCODING);

// ZIP File format reference: https://www.iana.org/assignments/media-types/application/zip
const CENTRAL_DIR_COMMENT_LEN_OFFSET = 32;
const CENTRAL_DIR_COMPRESSED_SIZE_OFFSET = 20;
const CENTRAL_DIR_COMPRESSION_OFFSET = 10;
const CENTRAL_DIR_CRC32_OFFSET = 16;
const CENTRAL_DIR_EXTRA_LEN_OFFSET = 30;
const CENTRAL_DIR_FILENAME_LEN_OFFSET = 28;
const CENTRAL_DIR_FIXED_SIZE = 46;
const CENTRAL_DIR_HEADER = 0x02014b50;
const CENTRAL_DIR_LOCAL_HEADER_OFFSET = 42;
const CENTRAL_DIR_UNCOMPRESSED_SIZE_OFFSET = 24;
const COMPRESSION_ALGO_STORE = 0; // no compression
const COMPRESSION_ALGO_DEFLATE = 8; // raw DEFLATE in ZIP entries
const END_OF_DIRECTORY_MIN_SIZE = 22;
const END_OF_DIRECTORY_RECORD = 0x06054b50;
const MAX_COMMENT_LENGTH = 0xffff; // uint16 max size
const END_OF_DIRECTORY_SEARCH_WINDOW = END_OF_DIRECTORY_MIN_SIZE + MAX_COMMENT_LENGTH;
const EOCD_CENTRAL_DIRECTORY_OFFSET_OFFSET = 16;
const EOCD_CENTRAL_DIRECTORY_SIZE_OFFSET = 12;
const LOCAL_FILE_EXTRA_LENGTH_OFFSET = 28;
const LOCAL_FILE_FILENAME_LENGTH_OFFSET = 26;
const LOCAL_FILE_FIXED_SIZE = 30;
const LOCAL_FILE_HEADER = 0x04034b50;

/**
 * Read-only access to decoded DNE files, whether stored in a directory or ZIP archive.
 */
export type DneDataSource = {
  /**
   * Lists available source filenames matching a DNE basename pattern.
   * @param glob - Filename or wildcard pattern such as `LOG_LOGRADOURO_*.TXT`.
   * @returns Matching basenames in deterministic order.
   */
  matchingFiles(glob: string): string[];
  /**
   * Streams decoded source records without line terminators.
   * @param file - A filename returned by `matchingFiles`.
   * @returns An asynchronous record sequence; source and archive validation failures propagate during iteration.
   */
  readLines(file: string): AsyncIterable<string>;
  /**
   * Optionally reads a complete decoded source file for loaders that support buffered parsing.
   * @param file - A filename returned by `matchingFiles`.
   * @returns The entire decoded file content.
   */
  readText?(file: string): Promise<string>;
};

type ZipEntry = {
  name: string;
  compression: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

/**
 * Reads Latin-1 DNE text files from one directory with a filename inventory captured at construction.
 */
export class DirectoryDneSource implements DneDataSource {
  private files: string[];

  /**
   * Captures the sorted file inventory for a directory.
   * @param path - Directory containing the DNE text files.
   * @throws {Error} If the directory cannot be scanned.
   */
  constructor(private path: string) {
    this.files = Array.from(
      new Bun.Glob('*').scanSync({ cwd: path, onlyFiles: true }),
    ).sort();
  }

  /**
   * Lists captured filenames that match a DNE source pattern.
   * @param glob - Basename or wildcard pattern.
   * @returns Matching basenames in sorted order.
   */
  matchingFiles(glob: string) {
    return matchingFiles(this.files, glob);
  }

  /**
   * Streams a captured source file as decoded Latin-1 records.
   * @param file - Basename returned by `matchingFiles`.
   * @returns Records without line terminators.
   * @throws {Error} If the file cannot be read.
   */
  async *readLines(file: string) {
    yield* decodeLines(Bun.file(join(this.path, file)).stream());
  }
}

class ZipDneSource implements DneDataSource {
  private files: string[];
  private entriesByFile: Map<string, ZipEntry>;

  constructor(
    private path: string,
    entries: ZipEntry[],
  ) {
    this.files = entries.map((entry) => basename(entry.name)).sort();
    this.entriesByFile = new Map(
      entries.map((entry) => [basename(entry.name), entry]),
    );
  }

  matchingFiles(glob: string) {
    return matchingFiles(this.files, glob);
  }

  async *readLines(file: string) {
    const entry = this.entriesByFile.get(file);
    if (!entry) {
      throw new Error(`DNE data file not found: ${file}`);
    }
    yield* decodeLines(streamZipEntry(this.path, entry));
  }
}

class BufferedZipDneSource implements DneDataSource {
  private files: string[];
  private entriesByFile: Map<string, ZipEntry>;

  constructor(
    private buffer: Buffer,
    entries: ZipEntry[],
  ) {
    this.files = entries.map((entry) => basename(entry.name)).sort();
    this.entriesByFile = new Map(
      entries.map((entry) => [basename(entry.name), entry]),
    );
  }

  matchingFiles(glob: string) {
    return matchingFiles(this.files, glob);
  }

  async *readLines(file: string) {
    yield* splitLines(await this.readText(file));
  }

  async readText(file: string) {
    const entry = this.entriesByFile.get(file);
    if (!entry) {
      throw new Error(`DNE data file not found: ${file}`);
    }

    return LATIN1_DECODER.decode(extractBufferedZipEntry(this.buffer, entry));
  }
}

/**
 * Finds a complete DNE source in a directory or its `Delimitado` subdirectory.
 * @param path - Candidate directory.
 * @param schema - Definitions describing all required source files.
 * @returns A directory-backed source, or null if no complete source is found.
 */
export function resolveDirectoryDneSource(
  path: string,
  schema: TableDefinition[],
): DneDataSource | null {
  if (!isDirectory(path)) {
    return null;
  }

  const direct = new DirectoryDneSource(path);
  if (!findMissingGlob(direct, schema)) {
    return direct;
  }

  const delimitedPath = join(path, DELIMITED_SUBDIR);
  if (!isDirectory(delimitedPath)) {
    return null;
  }

  const delimited = new DirectoryDneSource(delimitedPath);
  return findMissingGlob(delimited, schema) ? null : delimited;
}

/**
 * Resolves a ZIP source, materializing an embedded e-DNE ZIP when present.
 * @param path - Existing ZIP file path.
 * @param schema - Definitions describing all required source files.
 * @param nestedZipPath - Temporary path for an embedded archive; keep it available until all reads finish.
 * @returns A source that streams the selected archive entries and verifies their CRCs during reads.
 * @throws {Error} If archive parsing, required-file validation, or file access fails.
 */
export async function resolveZipDneSource(
  path: string,
  schema: TableDefinition[],
  nestedZipPath: string,
): Promise<DneDataSource> {
  const entries = await readZipEntriesFromFile(path);
  const nested = findNestedDneZip(entries);

  if (nested) {
    await materializeZipEntry(path, nested, nestedZipPath);
    return resolveStreamedZipEntries(
      nestedZipPath,
      await readZipEntriesFromFile(nestedZipPath),
      schema,
    );
  }

  return resolveStreamedZipEntries(path, entries, schema);
}

/**
 * Resolves a complete in-memory ZIP, including nested e-DNE archives, for comparative benchmarks.
 * @param buffer - Complete archive bytes, retained by the returned source.
 * @param schema - Definitions describing the required source files.
 * @returns A buffered source that decodes Latin-1 text and validates CRCs during reads.
 * @throws {Error} If the archive structure or required files are invalid.
 */
export function resolveBufferedZipDneSource(
  buffer: Buffer,
  schema: TableDefinition[],
): DneDataSource {
  const entries = readBufferedZipEntries(buffer);
  const nested = findNestedDneZip(entries);

  if (nested) {
    return resolveBufferedZipDneSource(
      Buffer.from(extractBufferedZipEntry(buffer, nested)),
      schema,
    );
  }

  const validEntries = requiredDneEntries(entries, schema);
  const source = new BufferedZipDneSource(buffer, validEntries);
  validateDneSource(source, validEntries, schema);
  return source;
}

function resolveStreamedZipEntries(
  path: string,
  entries: ZipEntry[],
  schema: TableDefinition[],
) {
  const validEntries = requiredDneEntries(entries, schema);
  const source = new ZipDneSource(path, validEntries);
  validateDneSource(source, validEntries, schema);
  return source;
}

function requiredDneEntries(entries: ZipEntry[], schema: TableDefinition[]) {
  return entries.filter((entry) => filenameIsRequiredDneBasicoFile(entry.name, schema));
}

function validateDneSource(
  source: DneDataSource,
  validEntries: ZipEntry[],
  schema: TableDefinition[],
) {
  if (!validEntries.length) {
    throw new Error('ZIP file does not contain DNE Basico files');
  }

  const missing = findMissingGlob(source, schema);
  if (missing) {
    throw new Error(`DNE data file not found: ${missing}`);
  }
}

function findNestedDneZip(entries: ZipEntry[]) {
  return entries.find((entry) => {
    const lowered = basename(entry.name).toLowerCase();
    return lowered.startsWith('edne_basico_') && lowered.endsWith('.zip');
  });
}

function isDirectory(path: string): boolean {
  try {
    new Bun.Glob('*').scanSync({ cwd: path, onlyFiles: true }).next();
    return true;
  } catch {
    return false;
  }
}

function findMissingGlob(source: DneDataSource, schema: TableDefinition[]) {
  for (const table of schema) {
    const glob = getTableFilesGlob(table);
    if (glob && source.matchingFiles(glob).length === 0) {
      return glob;
    }
  }
  return null;
}

function matchingFiles(files: string[], glob: string) {
  if (!glob.includes('*')) {
    return files.filter((file) => file === glob);
  }

  const [prefix = '', suffix = '',] = glob.split('*', 2);
  return files.filter(
    (file) => file.startsWith(prefix) && file.endsWith(suffix),
  );
}

function filenameIsRequiredDneBasicoFile(
  filename: string,
  schema: TableDefinition[],
) {
  const name = filename.toLowerCase();
  if (!name.startsWith(`${DELIMITED_SUBDIR.toLowerCase()}/`)) {
    return false;
  }

  const file = basename(name);
  return schema.some((table) => {
    const glob = getTableFilesGlob(table)?.toLowerCase();
    if (!glob) {
      return false;
    }
    if (!glob.includes('*')) {
      return file === glob;
    }

    const [prefix = '', suffix = '',] = glob.split('*', 2);
    return file.startsWith(prefix) && file.endsWith(suffix);
  });
}

async function readZipEntriesFromFile(path: string): Promise<ZipEntry[]> {
  const file = Bun.file(path);
  const fileSize = file.size;
  if (fileSize < END_OF_DIRECTORY_MIN_SIZE) {
    throw new Error('Source is not a valid ZIP file');
  }

  const tailStart = Math.max(0, fileSize - END_OF_DIRECTORY_SEARCH_WINDOW);
  const tail = Buffer.from(await file.slice(tailStart, fileSize).arrayBuffer());
  const eocdOffset = findEndOfCentralDirectory(tail);
  const centralDirectorySize = tail.readUInt32LE(eocdOffset + EOCD_CENTRAL_DIRECTORY_SIZE_OFFSET);
  const centralDirectoryOffset = tail.readUInt32LE(eocdOffset + EOCD_CENTRAL_DIRECTORY_OFFSET_OFFSET);
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;

  if (centralDirectoryEnd > fileSize) {
    throw new Error('Invalid ZIP central directory range');
  }

  const centralDirectory = Buffer.from(
    await file.slice(centralDirectoryOffset, centralDirectoryEnd).arrayBuffer(),
  );
  return parseCentralDirectory(centralDirectory);
}

function readBufferedZipEntries(buffer: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + EOCD_CENTRAL_DIRECTORY_SIZE_OFFSET);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + EOCD_CENTRAL_DIRECTORY_OFFSET_OFFSET);
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (centralDirectoryEnd > buffer.length) {
    throw new Error('Invalid ZIP central directory range');
  }
  return parseCentralDirectory(buffer.subarray(centralDirectoryOffset, centralDirectoryEnd));
}

function parseCentralDirectory(directory: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;

  while (offset < directory.length) {
    if (
      offset + CENTRAL_DIR_FIXED_SIZE > directory.length
      || directory.readUInt32LE(offset) !== CENTRAL_DIR_HEADER
    ) {
      throw new Error('Invalid ZIP central directory entry');
    }

    const compression = directory.readUInt16LE(offset + CENTRAL_DIR_COMPRESSION_OFFSET);
    const crc32 = directory.readUInt32LE(offset + CENTRAL_DIR_CRC32_OFFSET);
    const compressedSize = directory.readUInt32LE(offset + CENTRAL_DIR_COMPRESSED_SIZE_OFFSET);
    const uncompressedSize = directory.readUInt32LE(offset + CENTRAL_DIR_UNCOMPRESSED_SIZE_OFFSET);
    const filenameLength = directory.readUInt16LE(offset + CENTRAL_DIR_FILENAME_LEN_OFFSET);
    const extraLength = directory.readUInt16LE(offset + CENTRAL_DIR_EXTRA_LEN_OFFSET);
    const commentLength = directory.readUInt16LE(offset + CENTRAL_DIR_COMMENT_LEN_OFFSET);
    const localHeaderOffset = directory.readUInt32LE(offset + CENTRAL_DIR_LOCAL_HEADER_OFFSET);
    const entrySize = CENTRAL_DIR_FIXED_SIZE + filenameLength + extraLength + commentLength;
    if (offset + entrySize > directory.length) {
      throw new Error('Invalid ZIP central directory entry size');
    }

    const name = directory
      .subarray(
        offset + CENTRAL_DIR_FIXED_SIZE,
        offset + CENTRAL_DIR_FIXED_SIZE + filenameLength,
      )
      .toString('utf8');

    if (!name.endsWith('/')) {
      entries.push({
        name,
        compression,
        crc32,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
    }

    offset += entrySize;
  }

  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer) {
  for (
    let offset = buffer.length - END_OF_DIRECTORY_MIN_SIZE;
    offset >= Math.max(0, buffer.length - END_OF_DIRECTORY_SEARCH_WINDOW);
    offset--
  ) {
    if (buffer.readUInt32LE(offset) === END_OF_DIRECTORY_RECORD) {
      return offset;
    }
  }

  throw new Error('Source is not a valid ZIP file');
}

async function* streamZipEntry(path: string, entry: ZipEntry): AsyncIterable<Uint8Array> {
  const file = Bun.file(path);
  const headerEnd = entry.localHeaderOffset + LOCAL_FILE_FIXED_SIZE;
  const header = Buffer.from(
    await file.slice(entry.localHeaderOffset, headerEnd).arrayBuffer(),
  );
  if (
    header.length !== LOCAL_FILE_FIXED_SIZE
    || header.readUInt32LE(0) !== LOCAL_FILE_HEADER
  ) {
    throw new Error(`Invalid ZIP local header for ${entry.name}`);
  }

  const filenameLength = header.readUInt16LE(LOCAL_FILE_FILENAME_LENGTH_OFFSET);
  const extraLength = header.readUInt16LE(LOCAL_FILE_EXTRA_LENGTH_OFFSET);
  const dataStart = headerEnd + filenameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > file.size) {
    throw new Error(`Invalid ZIP data range for ${entry.name}`);
  }

  const compressed = file.slice(dataStart, dataEnd).stream();
  let stream: ReadableStream<Uint8Array>;
  if (entry.compression === COMPRESSION_ALGO_STORE) {
    stream = compressed;
  } else if (entry.compression === COMPRESSION_ALGO_DEFLATE) {
    stream = compressed.pipeThrough(new DecompressionStream('deflate-raw'));
  } else {
    throw new Error(
      `Unsupported ZIP compression method ${entry.compression} for ${entry.name}`,
    );
  }

  let uncompressedSize = 0;
  let crc32 = 0;
  for await (const chunk of stream) {
    uncompressedSize += chunk.byteLength;
    crc32 = Bun.hash.crc32(chunk, crc32);
    yield chunk;
  }

  if (entry.uncompressedSize && uncompressedSize !== entry.uncompressedSize) {
    throw new Error(`Invalid decompressed size for ${entry.name}`);
  }
  validateCrc32(entry, crc32);
}

async function materializeZipEntry(
  sourcePath: string,
  entry: ZipEntry,
  targetPath: string,
) {
  if (await Bun.file(targetPath).exists()) {
    return;
  }

  await mkdir(dirname(targetPath), { recursive: true });
  const partialPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const writer = Bun.file(partialPath).writer();
  let writerEnded = false;

  try {
    for await (const chunk of streamZipEntry(sourcePath, entry)) {
      await writer.write(chunk);
    }
    await writer.end();
    writerEnded = true;

    try {
      await rename(partialPath, targetPath);
    } catch (error) {
      if (!(await Bun.file(targetPath).exists())) {
        throw error;
      }
    }
  } finally {
    if (!writerEnded) {
      await Promise.resolve(writer.end()).catch(() => {});
    }
    await rm(partialPath, { force: true });
  }
}

async function* decodeLines(chunks: AsyncIterable<Uint8Array>) {
  const decoder = new TextDecoder(LATIN1_ENCODING);
  let pending = '';

  for await (const chunk of chunks) {
    const content = pending + decoder.decode(chunk, { stream: true });
    let start = 0;
    let end = content.indexOf('\n');

    while (end !== -1) {
      const lineEnd = end > start && content.charCodeAt(end - 1) === 13 ? end - 1 : end;
      if (lineEnd > start) {
        yield content.slice(start, lineEnd);
      }
      start = end + 1;
      end = content.indexOf('\n', start);
    }

    pending = content.slice(start);
  }

  pending += decoder.decode();
  if (pending.endsWith('\r')) {
    pending = pending.slice(0, -1);
  }
  if (pending) {
    yield pending;
  }
}

async function* splitLines(content: string) {
  let start = 0;

  for (let offset = 0; offset <= content.length; offset++) {
    if (offset !== content.length && content.charCodeAt(offset) !== 10) {
      continue;
    }

    let end = offset;
    if (end > start && content.charCodeAt(end - 1) === 13) {
      end--;
    }
    if (end > start) {
      yield content.slice(start, end);
    }
    start = offset + 1;
  }
}

function extractBufferedZipEntry(
  buffer: Buffer,
  entry: ZipEntry,
): Buffer<ArrayBufferLike> | Uint8Array<ArrayBuffer> {
  const offset = entry.localHeaderOffset;
  if (buffer.readUInt32LE(offset) !== LOCAL_FILE_HEADER) {
    throw new Error(`Invalid ZIP local header for ${entry.name}`);
  }

  const filenameLength = buffer.readUInt16LE(offset + LOCAL_FILE_FILENAME_LENGTH_OFFSET);
  const extraLength = buffer.readUInt16LE(offset + LOCAL_FILE_EXTRA_LENGTH_OFFSET);
  const dataStart = offset + LOCAL_FILE_FIXED_SIZE + filenameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compression === COMPRESSION_ALGO_STORE) {
    validateCrc32(entry, Bun.hash.crc32(compressed));
    return compressed;
  }

  if (entry.compression === COMPRESSION_ALGO_DEFLATE) {
    const inflated = Bun.inflateSync(new Uint8Array(compressed), {});
    if (entry.uncompressedSize && inflated.length !== entry.uncompressedSize) {
      throw new Error(`Invalid decompressed size for ${entry.name}`);
    }
    validateCrc32(entry, Bun.hash.crc32(inflated));
    return inflated;
  }

  throw new Error(
    `Unsupported ZIP compression method ${entry.compression} for ${entry.name}`,
  );
}

function validateCrc32(entry: ZipEntry, actual: number) {
  if (actual !== entry.crc32) {
    throw new Error(`CRC32 mismatch for ${entry.name}`);
  }
}
