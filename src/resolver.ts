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

export type RemoteDneSourceInfo = {
  url: string;
  lastModified: string | null;
  etag: string | null;
  contentLength: string | null;
  acceptRanges: string | null;
};

export type DneResolverOptions = {
  onProgress?: (message: string) => void;
  remoteInfo?: RemoteDneSourceInfo;
};

export class DneResolver {
  private tempDir?: string;

  constructor(
    private source?: string,
    private options: DneResolverOptions = {},
  ) {}

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
