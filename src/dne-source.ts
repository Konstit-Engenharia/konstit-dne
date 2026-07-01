import {
  basename,
  join,
} from 'node:path';
import {
  getTableFilesGlob,
  type TableDefinition,
} from './schema.ts';

const DELIMITED_SUBDIR = 'Delimitado';
const LATIN1_DECODER = new TextDecoder(
  'latin1' as ConstructorParameters<typeof TextDecoder>[0],
);

// ZIP File format reference: https://www.iana.org/assignments/media-types/application/zip
const CENTRAL_DIR_COMMENT_LEN_OFFSET = 32;
const CENTRAL_DIR_COMPRESSED_SIZE_OFFSET = 20;
const CENTRAL_DIR_COMPRESSION_OFFSET = 10;
const CENTRAL_DIR_EXTRA_LEN_OFFSET = 30;
const CENTRAL_DIR_FILENAME_LEN_OFFSET = 28;
const CENTRAL_DIR_FIXED_SIZE = 46;
const CENTRAL_DIR_HEADER = 0x02014b50;
const CENTRAL_DIR_LOCAL_HEADER_OFFSET = 42;
const CENTRAL_DIR_UNCOMPRESSED_SIZE_OFFSET = 24;
const COMPRESSION_ALGO_STORE = 0; // no compression
const COMPRESSION_ALGO_DEFLATE = 8; // zlib's deflate
const END_OF_DIRECTORY_MIN_SIZE = 22;
const END_OF_DIRECTORY_RECORD = 0x06054b50;
const MAX_COMMENT_LENGTH = 0xffff; // uint16
const END_OF_DIRECTORY_SEARCH_WINDOW = END_OF_DIRECTORY_MIN_SIZE + MAX_COMMENT_LENGTH;
const EOCD_CENTRAL_DIRECTORY_OFFSET_OFFSET = 16;
const EOCD_CENTRAL_DIRECTORY_SIZE_OFFSET = 12;
const LOCAL_FILE_EXTRA_LENGTH_OFFSET = 28;
const LOCAL_FILE_FILENAME_LENGTH_OFFSET = 26;
const LOCAL_FILE_FIXED_SIZE = 30;
const LOCAL_FILE_HEADER = 0x04034b50;

export type DneDataSource = {
  matchingFiles(glob: string): string[];
  readText(file: string): Promise<string>;
};

type ZipEntry = {
  name: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

export class DirectoryDneSource implements DneDataSource {
  private files: string[];

  constructor(private path: string) {
    this.files = Array.from(
      new Bun.Glob('*').scanSync({ cwd: path, onlyFiles: true }),
    ).sort();
  }

  matchingFiles(glob: string) {
    return matchingFiles(this.files, glob);
  }

  async readText(file: string): Promise<string> {
    return LATIN1_DECODER.decode(await Bun.file(join(this.path, file)).bytes());
  }
}

class ZipDneSource implements DneDataSource {
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

  async readText(file: string) {
    const entry = this.entriesByFile.get(file);
    if (!entry) {
      throw new Error(`DNE data file not found: ${file}`);
    }
    return LATIN1_DECODER.decode(extractZipEntry(this.buffer, entry));
  }
}

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

export function resolveZipDneSource(
  buffer: Buffer,
  schema: TableDefinition[],
): DneDataSource {
  const entries = readZipEntries(buffer);
  const nested = entries.find((entry) => {
    const lowered = basename(entry.name).toLowerCase();
    return lowered.startsWith('edne_basico_') && lowered.endsWith('.zip');
  });

  if (nested) {
    return resolveZipDneSource(
      Buffer.from(extractZipEntry(buffer, nested)),
      schema,
    );
  }

  const validEntries = entries.filter((entry) => filenameIsRequiredDneBasicoFile(entry.name, schema));
  if (!validEntries.length) {
    throw new Error('ZIP file does not contain DNE Basico files');
  }

  const source = new ZipDneSource(buffer, validEntries);
  const missing = findMissingGlob(source, schema);
  if (missing) {
    throw new Error(`DNE data file not found: ${missing}`);
  }
  return source;
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

  const [prefix, suffix,] = glob.split('*', 2);
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

    const [prefix, suffix,] = glob.split('*', 2);
    return file.startsWith(prefix) && file.endsWith(suffix);
  });
}

function readZipEntries(b: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(b);
  const centralDirectorySize = b.readUInt32LE(eocdOffset + EOCD_CENTRAL_DIRECTORY_SIZE_OFFSET);
  const centralDirectoryOffset = b.readUInt32LE(eocdOffset + EOCD_CENTRAL_DIRECTORY_OFFSET_OFFSET);
  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;
  const end = centralDirectoryOffset + centralDirectorySize;

  while (offset < end) {
    if (b.readUInt32LE(offset) !== CENTRAL_DIR_HEADER) {
      break;
    }

    const compression = b.readUInt16LE(offset + CENTRAL_DIR_COMPRESSION_OFFSET);
    const compressedSize = b.readUInt32LE(offset + CENTRAL_DIR_COMPRESSED_SIZE_OFFSET);
    const uncompressedSize = b.readUInt32LE(offset + CENTRAL_DIR_UNCOMPRESSED_SIZE_OFFSET);
    const filenameLength = b.readUInt16LE(offset + CENTRAL_DIR_FILENAME_LEN_OFFSET);
    const extraLength = b.readUInt16LE(offset + CENTRAL_DIR_EXTRA_LEN_OFFSET);
    const commentLength = b.readUInt16LE(offset + CENTRAL_DIR_COMMENT_LEN_OFFSET);
    const localHeaderOffset = b.readUInt32LE(offset + CENTRAL_DIR_LOCAL_HEADER_OFFSET);
    const name = b
      .subarray(
        offset + CENTRAL_DIR_FIXED_SIZE,
        offset + CENTRAL_DIR_FIXED_SIZE + filenameLength,
      )
      .toString('utf8');

    if (!name.endsWith('/')) {
      entries.push({
        name,
        compression,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
    }

    offset += CENTRAL_DIR_FIXED_SIZE
      + filenameLength
      + extraLength
      + commentLength;
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

function extractZipEntry(buffer: Buffer, entry: ZipEntry): Buffer<ArrayBufferLike> | Uint8Array<ArrayBuffer> {
  const offset = entry.localHeaderOffset;
  if (buffer.readUInt32LE(offset) !== LOCAL_FILE_HEADER) {
    throw new Error(`Invalid ZIP local header for ${entry.name}`);
  }

  const filenameLength = buffer.readUInt16LE(offset + LOCAL_FILE_FILENAME_LENGTH_OFFSET);
  const extraLength = buffer.readUInt16LE(offset + LOCAL_FILE_EXTRA_LENGTH_OFFSET);
  const dataStart = offset + LOCAL_FILE_FIXED_SIZE + filenameLength + extraLength;
  const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compression === COMPRESSION_ALGO_STORE) {
    return compressed;
  }

  if (entry.compression === COMPRESSION_ALGO_DEFLATE) {
    const inflated = Bun.inflateSync(new Uint8Array(compressed), {});
    if (entry.uncompressedSize && inflated.length !== entry.uncompressedSize) {
      throw new Error(`Invalid decompressed size for ${entry.name}`);
    }
    return inflated;
  }

  throw new Error(
    `Unsupported ZIP compression method ${entry.compression} for ${entry.name}`,
  );
}
