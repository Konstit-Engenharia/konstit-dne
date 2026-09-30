import {
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveDirectoryDneSource,
  resolveZipDneSource,
  type DneDataSource,
} from './dne-source.ts';
import {
  downloadRemoteFile,
  requestWithRetry,
  type HttpRequestOptions,
} from './parallel-download.ts';
import type { TableDefinition } from './schema.ts';
import { EDNE_DOWNLOAD_URL } from './settings.ts';

/**
 * Remote-source identity and raw HTTP validators obtained without downloading the full archive.
 */
export type RemoteDneSourceInfo = {
  /**
   * Source URL used for inspection and subsequent download.
   */
  url: string;
  /**
   * Raw Last-Modified header, or null when absent.
   */
  lastModified: string | null;
  /**
   * Raw ETag header, or null when absent.
   */
  etag: string | null;
  /**
   * Total resource length in bytes as header text, or null when unknown.
   */
  contentLength: string | null;
  /**
   * Raw Accept-Ranges header, or inferred byte-range support for a successful range probe.
   */
  acceptRanges: string | null;
};

/**
 * Optional progress reporting and reusable remote inspection information.
 */
export type DneResolverOptions = {
  /**
   * Receives synchronous human-readable source-resolution progress messages.
   */
  onProgress?: (message: string) => void;
  /**
   * Previously inspected headers for this source, avoiding a repeated network probe.
   */
  remoteInfo?: RemoteDneSourceInfo;
};

/**
 * Resolves a directory, local ZIP, or remote ZIP and owns any temporary files created during resolution.
 */
export class DneResolver {
  private tempDir?: string;

  /**
   * Configures a source resolver without reading or downloading data.
   * @param source - Directory, ZIP path, or HTTP(S) URL; omission selects the configured Correios source.
   * @param options - Optional progress callback and remote-source headers.
   */
  constructor(
    private source?: string,
    private options: DneResolverOptions = {},
  ) {}

  /**
   * Resolves and validates the required DNE source files.
   * @param schema - Source definitions used to check required filenames.
   * @returns A source that remains usable until `cleanup()` removes its temporary files.
   * @throws {Error} If downloading, archive parsing, or source validation fails; temporary files are cleaned on failure.
   */
  async resolve(schema: TableDefinition[]): Promise<DneDataSource> {
    try {
      return await this.resolveSource(
        this.source ?? EDNE_DOWNLOAD_URL,
        schema,
      );
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Removes temporary files owned by this resolver.
   * Call only after all consumers finish reading the resolved source. Repeated calls are safe.
   * @throws {Error} If the temporary directory cannot be removed.
   */
  async cleanup() {
    if (this.tempDir) {
      await rm(this.tempDir, { recursive: true, force: true });
      this.tempDir = undefined;
    }
  }

  private async getTempDir() {
    this.tempDir ??= await mkdtemp(join(tmpdir(), 'edne'));
    return this.tempDir;
  }

  private async resolveSource(
    source: string,
    schema: TableDefinition[],
  ): Promise<DneDataSource> {
    let path = source;

    if (looksLikeUrl(source)) {
      path = await this.download(source);
    }

    if (await Bun.file(path).exists()) {
      this.progress('Preparando a fonte ZIP');
      const nestedZipPath = join(await this.getTempDir(), 'edne-inner.zip');
      const resolved = await resolveZipDneSource(path, schema, nestedZipPath);
      this.progress('Fonte ZIP pronta');
      return resolved;
    }

    this.progress('Lendo a fonte do diretório');
    const directorySource = resolveDirectoryDneSource(path, schema);
    if (directorySource) {
      this.progress('Fonte do diretório pronta');
      return directorySource;
    }

    throw new Error(`DNE source not found: ${path}`);
  }

  private async download(url: string) {
    const info = this.options.remoteInfo ?? await inspectRemoteDneSource(url);
    const tempDir = await this.getTempDir();
    const path = join(tempDir, 'edne-download.zip');

    this.progress('Baixando o arquivo DNE');
    await downloadRemoteFile(url, path, info);
    return path;
  }

  private progress(message: string) {
    this.options.onProgress?.(message);
  }
}

/**
 * Inspects HTTP validators using HEAD, with a one-byte range-request fallback.
 * @param url - HTTP(S) URL of the source archive.
 * @param options - Timeout, retry, and cancellation settings.
 * @returns Source identity and available HTTP headers.
 * @throws {Error} If both inspection strategies fail or the operation is aborted.
 */
export async function inspectRemoteDneSource(
  url: string,
  options: HttpRequestOptions = {},
): Promise<RemoteDneSourceInfo> {
  try {
    return await requestWithRetry(url, { method: 'HEAD' }, async (response) => {
      if (!response.ok) {
        throw new Error(`Failed to inspect DNE from ${url}: ${response.status}`);
      }
      return remoteInfoFromHeaders(url, response.headers);
    }, options);
  } catch {
    return await requestWithRetry(
      url,
      {
        headers: {
          'accept-encoding': 'identity',
          'range': 'bytes=0-0',
        },
      },
      async (response) => {
        const info = remoteInfoFromRangeResponse(url, response);
        await response.body?.cancel();
        if (!response.ok) {
          throw new Error(`Failed to inspect DNE from ${url}: ${response.status}`);
        }
        return info;
      },
      options,
    );
  }
}

function remoteInfoFromHeaders(url: string, headers: Headers): RemoteDneSourceInfo {
  return {
    url,
    lastModified: headers.get('last-modified'),
    etag: headers.get('etag'),
    contentLength: headers.get('content-length'),
    acceptRanges: headers.get('accept-ranges'),
  };
}

function remoteInfoFromRangeResponse(url: string, response: Response): RemoteDneSourceInfo {
  const info = remoteInfoFromHeaders(url, response.headers);
  if (response.status !== 206) {
    return info;
  }
  const match = /^bytes 0-0\/(\d+)$/i.exec(response.headers.get('content-range') ?? '');
  return {
    ...info,
    contentLength: match?.[1] ?? null,
    acceptRanges: info.acceptRanges ?? 'bytes',
  };
}

function looksLikeUrl(value: string | URL) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
