import {
  parseCentralDirectory,
  zipEntryIdentities,
} from './dne-source.ts';
import {
  requestWithRetry,
  type HttpRequestOptions,
} from './parallel-download.ts';
import {
  inspectRemoteDneSource,
  type RemoteDneSourceInfo,
} from './resolver.ts';
import type { TableDefinition } from './schema.ts';

const TRAILER_SIZE = 22;
const MAX_TAIL_SIZE = TRAILER_SIZE + 0xffff;
const MAX_DIRECTORY_SIZE = 4 * 1024 * 1024;

/** Inspects ZIP entry identities using bounded ranges; failed probes require a full download. */
export async function inspectRemoteDneZipSource(
  url: string,
  schema: TableDefinition[],
  options: HttpRequestOptions = {},
): Promise<RemoteDneSourceInfo> {
  try {
    return await inspectZip(url, schema, options);
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? error;
    }
    const info = await inspectRemoteDneSource(url, options);
    return { ...info, acceptRanges: null, zipEntries: null };
  }
}

async function inspectZip(url: string, schema: TableDefinition[], options: HttpRequestOptions) {
  let tail = await readRange(url, { suffix: TRAILER_SIZE }, options);
  let trailerOffset = findTrailer(tail.bytes);
  if (trailerOffset < 0) {
    tail = await readRange(url, { suffix: MAX_TAIL_SIZE }, options);
    trailerOffset = findTrailer(tail.bytes);
  }
  if (trailerOffset < 0) {
    throw new Error('Missing ZIP central directory trailer');
  }

  const trailer = tail.bytes.subarray(trailerOffset);
  const count = trailer.readUInt16LE(10);
  const size = trailer.readUInt32LE(12);
  const start = trailer.readUInt32LE(16);
  const trailerStart = tail.start + trailerOffset;
  if (
    trailer.readUInt16LE(4) !== 0 || trailer.readUInt16LE(6) !== 0
    || trailer.readUInt16LE(8) !== count || count === 0 || count === 0xffff
    || size === 0 || size > MAX_DIRECTORY_SIZE || start === 0xffffffff
    || start + size !== trailerStart
  ) {
    throw new Error('Unsupported ZIP central directory layout');
  }

  const directory = start >= tail.start
    ? tail.bytes.subarray(start - tail.start, start - tail.start + size)
    : (await readRange(url, { start, end: start + size - 1, total: tail.total }, options)).bytes;
  const entries = parseCentralDirectory(directory, count);
  if (
    entries.some((entry) =>
      entry.disk !== 0 || (entry.flags & 0x2041) !== 0
      || entry.compressedSize === 0xffffffff || entry.uncompressedSize === 0xffffffff
      || entry.localHeaderOffset + 30 + entry.compressedSize > start
      || (entry.compression !== 0 && entry.compression !== 8)
    )
  ) {
    throw new Error('Unsupported ZIP entry layout');
  }
  const zipEntries = zipEntryIdentities(entries, schema);
  if (zipEntries.length === 0 || new Set(zipEntries.map((entry) => entry.name)).size !== zipEntries.length) {
    throw new Error('Missing or ambiguous DNE ZIP entries');
  }
  return { ...tail.info, zipEntries };
}

function findTrailer(bytes: Buffer) {
  for (let offset = bytes.length - TRAILER_SIZE; offset >= 0; offset--) {
    if (
      bytes.readUInt32LE(offset) === 0x06054b50
      && offset + TRAILER_SIZE + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      return offset;
    }
  }
  return -1;
}

type InspectionRange = { suffix: number; } | { start: number; end: number; total: number; };

async function readRange(url: string, range: InspectionRange, options: HttpRequestOptions) {
  const header = 'suffix' in range ? `bytes=-${range.suffix}` : `bytes=${range.start}-${range.end}`;
  return requestWithRetry(url, { headers: { 'range': header, 'accept-encoding': 'identity' } }, async (response) => {
    try {
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') ?? '');
      if (response.status !== 206 || !match) {
        throw new Error('ZIP range inspection is not supported');
      }
      const start = Number(match[1]);
      const end = Number(match[2]);
      const total = Number(match[3]);
      const expectedStart = 'suffix' in range ? Math.max(0, total - range.suffix) : range.start;
      const expectedEnd = 'suffix' in range ? total - 1 : range.end;
      const encoding = response.headers.get('content-encoding');
      const length = response.headers.get('content-length');
      if (
        !Number.isSafeInteger(total) || total < TRAILER_SIZE
        || start !== expectedStart || end !== expectedEnd
        || (!('suffix' in range) && total !== range.total)
        || (encoding !== null && encoding !== 'identity')
        || (length !== null && Number(length) !== end - start + 1)
      ) {
        throw new Error('Invalid ZIP range response');
      }
      const bytes = await readBoundedBody(response, end - start + 1);
      const info: RemoteDneSourceInfo = {
        url,
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
        contentLength: String(total),
        acceptRanges: 'bytes',
      };
      return { bytes, start, total, info };
    } finally {
      await response.body?.cancel();
    }
  }, options);
}

async function readBoundedBody(response: Response, size: number) {
  if (!response.body) {
    throw new Error('Empty ZIP range response');
  }
  const reader = response.body.getReader();
  const bytes = Buffer.alloc(size);
  let offset = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      if (offset + chunk.value.length > size) {
        throw new Error('Oversized ZIP range response');
      }
      bytes.set(chunk.value, offset);
      offset += chunk.value.length;
    }
    if (offset !== size) {
      throw new Error('Truncated ZIP range response');
    }
    return bytes;
  } finally {
    reader.releaseLock();
  }
}
