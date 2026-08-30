import {
  open,
  type FileHandle,
} from 'node:fs/promises';
import {
  HTTP_FETCH_CHUNK_SIZE,
  HTTP_FETCH_CONCURRENCY,
  HTTP_FETCH_MAX_RETRIES,
  HTTP_FETCH_RETRY_AFTER_MAX_MS,
  HTTP_FETCH_RETRY_BASE_DELAY_MS,
  HTTP_FETCH_RETRY_MAX_DELAY_MS,
  HTTP_FETCH_TIMEOUT_MS,
} from './settings.ts';

type RemoteFileInfo = {
  acceptRanges: string | null;
  contentLength: string | null;
};

type ByteRange = {
  start: number;
  end: number;
};

export type HttpRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  retryAfterMaxMs?: number;
};

class RangeNotSupportedError extends Error {
  // biome-ignore lint/complexity/noUselessConstructor: Bun cannot cover the synthesized constructor.
  constructor(message: string) {
    super(message);
  }
}

export async function downloadRemoteFile(
  url: string,
  path: string,
  info: RemoteFileInfo,
  options: HttpRequestOptions = {},
) {
  const contentLength = parseContentLength(info.contentLength);
  if (!supportsByteRanges(info.acceptRanges) || contentLength === null) {
    await downloadSerial(url, path, options);
    return;
  }

  try {
    await downloadRanges(url, path, contentLength, options);
  } catch (error) {
    if (!(error instanceof RangeNotSupportedError)) {
      throw error;
    }
    await downloadSerial(url, path, options);
  }
}

async function downloadRanges(
  url: string,
  path: string,
  contentLength: number,
  options: HttpRequestOptions,
) {
  const chunkCount = Math.ceil(contentLength / HTTP_FETCH_CHUNK_SIZE);
  const file = await open(path, 'w');
  const controller = new AbortController();
  const signal = combineAbortSignals(options.signal, controller.signal);

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
          await fetchRange(url, file, { start, end }, contentLength, {
            ...options,
            signal,
          });
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
  options: HttpRequestOptions,
) {
  await requestWithRetry(
    url,
    {
      headers: {
        'accept-encoding': 'identity',
        'range': `bytes=${range.start}-${range.end}`,
      },
    },
    async (response) => {
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
    },
    options,
  );
}

async function downloadSerial(url: string, path: string, options: HttpRequestOptions) {
  const file = await open(path, 'w');

  try {
    await requestWithRetry(url, {}, async (response) => {
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Failed to download ${url}: ${response.status}`);
      }
      if (!response.body) {
        throw new Error(`Failed to stream ${url}: empty response body`);
      }

      await file.truncate(0);
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
      }
    }, options);
  } finally {
    await file.close();
  }
}

export async function requestWithRetry<T>(
  url: string,
  init: RequestInit,
  consume: (response: Response) => Promise<T>,
  options: HttpRequestOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? HTTP_FETCH_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? HTTP_FETCH_MAX_RETRIES;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? HTTP_FETCH_RETRY_BASE_DELAY_MS;
  const retryMaxDelayMs = options.retryMaxDelayMs ?? HTTP_FETCH_RETRY_MAX_DELAY_MS;
  const retryAfterMaxMs = options.retryAfterMaxMs ?? HTTP_FETCH_RETRY_AFTER_MAX_MS;

  for (let attempt = 0;; attempt++) {
    throwIfAborted(options.signal);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = combineAbortSignals(options.signal, timeoutSignal);

    try {
      const response = await fetch(url, {
        ...init,
        signal,
        verbose: false,
      });
      if (isRetryableStatus(response.status) && attempt < maxRetries) {
        const delayMs = getRetryDelayMs(
          response.headers.get('retry-after'),
          attempt,
          retryBaseDelayMs,
          retryMaxDelayMs,
          retryAfterMaxMs,
        );
        await response.body?.cancel();
        await abortableDelay(delayMs, options.signal);
        continue;
      }
      return await consume(response);
    } catch (error) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? error;
      }
      if (attempt >= maxRetries || !isTransientNetworkError(error)) {
        throw error;
      }
      const delayMs = Math.min(retryBaseDelayMs * 2 ** attempt, retryMaxDelayMs);
      await abortableDelay(delayMs, options.signal);
    }
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

function isRetryableStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500 && status <= 599;
}

function isTransientNetworkError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === 'AbortError' || error.name === 'TimeoutError' || error instanceof TypeError) {
    return true;
  }
  const code = 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
  return code === 'ECONNRESET'
    || code === 'ECONNREFUSED'
    || code === 'EHOSTUNREACH'
    || code === 'ENETUNREACH'
    || code === 'ETIMEDOUT'
    || code === 'EAI_AGAIN';
}

function getRetryDelayMs(
  retryAfter: string | null,
  attempt: number,
  retryBaseDelayMs: number,
  retryMaxDelayMs: number,
  retryAfterMaxMs: number,
) {
  const parsedRetryAfter = parseRetryAfterMs(retryAfter);
  if (parsedRetryAfter !== null) {
    return Math.min(parsedRetryAfter, retryAfterMaxMs);
  }
  return Math.min(retryBaseDelayMs * 2 ** attempt, retryMaxDelayMs);
}

function parseRetryAfterMs(value: string | null) {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed) * 1_000;
  }
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function combineAbortSignals(first: AbortSignal | undefined, second: AbortSignal) {
  return first ? AbortSignal.any([first, second]) : second;
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
  }
}

async function abortableDelay(delayMs: number, signal: AbortSignal | undefined) {
  if (delayMs <= 0) {
    throwIfAborted(signal);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timeout = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  });
}
