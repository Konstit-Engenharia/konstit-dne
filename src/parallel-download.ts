import {
  open,
  type FileHandle,
} from 'node:fs/promises';
import {
  HTTP_FETCH_CHUNK_SIZE,
  HTTP_FETCH_CONCURRENCY,
} from './settings.ts';

type RemoteFileInfo = {
  acceptRanges: string | null;
  contentLength: string | null;
};

type ByteRange = {
  start: number;
  end: number;
};

class RangeNotSupportedError extends Error {}

export async function downloadRemoteFile(
  url: string,
  path: string,
  info: RemoteFileInfo,
) {
  const contentLength = parseContentLength(info.contentLength);
  if (!supportsByteRanges(info.acceptRanges) || contentLength === null) {
    await downloadSerial(url, path);
    return;
  }

  try {
    await downloadRanges(url, path, contentLength);
  } catch (error) {
    if (!(error instanceof RangeNotSupportedError)) {
      throw error;
    }
    await downloadSerial(url, path);
  }
}

async function downloadRanges(url: string, path: string, contentLength: number) {
  const chunkCount = Math.ceil(contentLength / HTTP_FETCH_CHUNK_SIZE);
  const file = await open(path, 'w');
  const controller = new AbortController();

  try {
    await file.truncate(contentLength);
    let nextChunk = 0;
    const workers = Array.from(
      { length: Math.min(chunkCount, HTTP_FETCH_CONCURRENCY) },
      async () => {
        while (true) {
          const chunkIndex = nextChunk++;
          if (chunkIndex >= chunkCount) {
            return;
          }

          const start = chunkIndex * HTTP_FETCH_CHUNK_SIZE;
          const end = Math.min(start + HTTP_FETCH_CHUNK_SIZE, contentLength) - 1;
          await fetchRange(url, file, { start, end }, contentLength, controller.signal);
        }
      },
    );

    try {
      await Promise.all(workers);
    } catch (error) {
      controller.abort();
      await Promise.allSettled(workers);
      throw error;
    }
  } finally {
    await file.close();
  }
}

async function fetchRange(
  url: string,
  file: FileHandle,
  range: ByteRange,
  contentLength: number,
  signal: AbortSignal,
) {
  const response = await fetch(url, {
    headers: {
      'accept-encoding': 'identity',
      range: `bytes=${range.start}-${range.end}`,
    },
    signal,
    verbose: false,
  });

  if (response.status !== 206) {
    await response.body?.cancel();
    if (response.ok) {
      throw new RangeNotSupportedError(`Server ignored byte range ${range.start}-${range.end}`);
    }
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }

  const contentRange = parseContentRange(response.headers.get('content-range'));
  if (
    !contentRange
    || contentRange.start !== range.start
    || contentRange.end !== range.end
    || contentRange.length !== contentLength
  ) {
    await response.body?.cancel();
    throw new RangeNotSupportedError(`Server returned an invalid Content-Range for ${range.start}-${range.end}`);
  }

  const content = new Uint8Array(await response.arrayBuffer());
  const expectedLength = range.end - range.start + 1;
  if (content.byteLength !== expectedLength) {
    throw new RangeNotSupportedError(
      `Server returned ${content.byteLength} bytes for range ${range.start}-${range.end}; expected ${expectedLength}`,
    );
  }
  await writeAll(file, content, range.start);
}

async function downloadSerial(url: string, path: string) {
  const response = await fetch(url, { verbose: false });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }
  if (!response.body) {
    throw new Error(`Failed to stream ${url}: empty response body`);
  }

  const file = await open(path, 'w');
  const reader = response.body.getReader();
  let position = 0;

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      await writeAll(file, chunk.value, position);
      position += chunk.value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
    await file.close();
  }
}

async function writeAll(file: FileHandle, content: Uint8Array, position: number) {
  let offset = 0;
  while (offset < content.byteLength) {
    const result = await file.write(content, offset, content.byteLength - offset, position + offset);
    if (!result.bytesWritten) {
      throw new Error('Failed to write downloaded content');
    }
    offset += result.bytesWritten;
  }
}

function supportsByteRanges(value: string | null) {
  return value
    ?.split(',')
    .some((range) => range.trim().toLowerCase() === 'bytes') ?? false;
}

function parseContentLength(value: string | null) {
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

function parseContentRange(value: string | null) {
  const match = value ? /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(value) : null;
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    length: Number(match[3]),
  };
}
