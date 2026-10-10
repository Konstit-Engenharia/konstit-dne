import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';

/** Reads into shared storage, copying once for Bun's embedded files. Publish only after this function returns. */
export function readSharedFile(path: string): SharedArrayBuffer {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    // Bun's virtual assets support readFileSync but do not expose OS file descriptors.
    const bytes = readFileSync(path);
    const buffer = new SharedArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return buffer;
  }
  try {
    const buffer = new SharedArrayBuffer(fstatSync(fd).size);
    const bytes = new Uint8Array(buffer);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(fd, bytes, offset, bytes.byteLength - offset, offset);
      if (count === 0) {
        throw new Error(`File ended while loading shared snapshot: ${path}`);
      }
      offset += count;
    }
    return buffer;
  } finally {
    closeSync(fd);
  }
}
