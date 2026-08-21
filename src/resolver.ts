import {
  mkdir,
  mkdtemp,
  rm,
} from 'node:fs/promises';
import {
  homedir,
  tmpdir,
} from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import {
  resolveDirectoryDneSource,
  resolveZipDneSource,
  type DneDataSource,
} from './dne-source.ts';
import type { TableDefinition } from './schema.ts';
import {
  CACHE_LAST_MODIFIED_BUCKET_MS,
  EDNE_DOWNLOAD_URL,
} from './settings.ts';

export type RemoteDneSourceInfo = {
  url: string;
  lastModified: string | null;
  etag: string | null;
  contentLength: string | null;
};

export class DneResolver {
  private tempDir?: string;
  private nestedZipPath?: string;

  constructor(
    private source?: string,
    private options: { skipCache?: boolean; } = {},
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
      const nestedZipPath = this.nestedZipPath
        ?? join(await this.getTempDir(), 'edne-inner.zip');
      return await resolveZipDneSource(path, schema, nestedZipPath);
    }

    const directorySource = resolveDirectoryDneSource(path, schema);
    if (directorySource) {
      return directorySource;
    }

    throw new Error(`DNE source not found: ${path}`);
  }

  private async download(url: string) {
    const info = await inspectRemoteDneSource(url);
    const cachedPath = this.options.skipCache ? null : await cachedDownloadPath(info);
    const cachedInnerPath = cachedPath ? `${cachedPath}.inner.zip` : null;
    if (cachedInnerPath && (await Bun.file(cachedInnerPath).exists())) {
      return cachedInnerPath;
    }
    if (cachedPath && (await Bun.file(cachedPath).exists())) {
      this.nestedZipPath = cachedInnerPath ?? undefined;
      return cachedPath;
    }

    const tempDir = await this.getTempDir();
    const path = join(tempDir, 'edne-download.zip');

    await downloadSimple(url, path);
    if (cachedPath) {
      await cacheDownloadedFile(path, cachedPath);
      this.nestedZipPath = cachedInnerPath ?? undefined;
    }
    return path;
  }
}

export async function inspectRemoteDneSource(
  url: string,
): Promise<RemoteDneSourceInfo> {
  const response = await fetch(url, { method: 'HEAD' });
  if (!response.ok) {
    throw new Error(`Failed to inspect DNE from ${url}: ${response.status}`);
  }

  return {
    url,
    lastModified: response.headers.get('last-modified'),
    etag: response.headers.get('etag'),
    contentLength: response.headers.get('content-length'),
  };
}

async function downloadSimple(url: string, path: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download DNE from ${url}: ${response.status}`);
  }
  if (!response.body) {
    throw new Error(`Failed to stream DNE from ${url}: empty response body`);
  }

  const reader = response.body.getReader();
  const writer = Bun.file(path).writer();

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      void writer.write(chunk.value);
    }
  } finally {
    await writer.end();
    reader.releaseLock();
  }
}

function looksLikeUrl(value: string | URL) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

async function cachedDownloadPath(info: RemoteDneSourceInfo) {
  if (process.env['EDNE_DISABLE_DOWNLOAD_CACHE'] === '1') {
    return null;
  }
  if (!info.contentLength) {
    return null;
  }

  const cacheDir = join(
    homedir() || tmpdir(),
    '.cache',
    'edne',
  );
  const key = new Bun.CryptoHasher('sha1')
    .update(`${info.url}\0${info.contentLength}\0${cacheVersionToken(info)}`)
    .digest('hex');
  return join(cacheDir, `${key}.zip`);
}

function cacheVersionToken(info: RemoteDneSourceInfo) {
  if (info.lastModified) {
    const time = Date.parse(info.lastModified);
    if (Number.isFinite(time)) {
      return String(Math.floor(time / CACHE_LAST_MODIFIED_BUCKET_MS));
    }
    return info.lastModified;
  }

  return info.etag ?? '';
}

async function cacheDownloadedFile(source: string, target: string): Promise<void> {
  const partial = `${target}.${process.pid}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await Bun.write(partial, Bun.file(source));
  await Bun.file(target)
    .delete()
    .catch(() => {});
  await Bun.write(target, Bun.file(partial));
  await Bun.file(partial)
    .delete()
    .catch(() => {});
}
