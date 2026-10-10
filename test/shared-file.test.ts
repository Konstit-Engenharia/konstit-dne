import { afterAll, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSharedFile } from '../src/shared-file.ts';

const directory = fs.mkdtempSync(join(tmpdir(), 'dne-shared-file-'));
const path = join(directory, 'bytes.bin');
const content = Uint8Array.from({ length: 32 }, (_, index) => index);
fs.writeFileSync(path, content);
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

test('reads partial file chunks into the final shared buffer and closes the descriptor', () => {
  const read = fs.readSync.bind(fs);
  const partial = spyOn(fs, 'readSync').mockImplementationOnce((fd, buffer) => read(fd, buffer, 0, 3, 0));
  const close = spyOn(fs, 'closeSync');
  try {
    const buffer = readSharedFile(path);
    expect(buffer).toBeInstanceOf(SharedArrayBuffer);
    expect([...new Uint8Array(buffer)]).toEqual([...content]);
    expect(partial).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    partial.mockRestore();
    close.mockRestore();
  }
});

test('rejects a file truncated during loading and still closes the descriptor', () => {
  const read = spyOn(fs, 'readSync').mockReturnValueOnce(0);
  const close = spyOn(fs, 'closeSync');
  try {
    expect(() => readSharedFile(path)).toThrow('File ended while loading shared snapshot');
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    read.mockRestore();
    close.mockRestore();
  }
});

test('copies file bytes into shared storage when only the virtual file reader can open it', () => {
  const open = spyOn(fs, 'openSync').mockImplementationOnce(() => {
    throw Object.assign(new Error('No native descriptor'), { code: 'ENOENT' });
  });
  const read = spyOn(fs, 'readFileSync');
  try {
    const buffer = readSharedFile(path);
    expect(buffer).toBeInstanceOf(SharedArrayBuffer);
    expect([...new Uint8Array(buffer)]).toEqual([...content]);
    expect(read).toHaveBeenCalledWith(path);
  } finally {
    open.mockRestore();
    read.mockRestore();
  }
});

test('preserves native access errors without retrying through the virtual file reader', () => {
  const error = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
  const open = spyOn(fs, 'openSync').mockImplementationOnce(() => { throw error; });
  const read = spyOn(fs, 'readFileSync');
  try {
    expect(() => readSharedFile(path)).toThrow(error);
    expect(read).not.toHaveBeenCalled();
  } finally {
    open.mockRestore();
    read.mockRestore();
  }
});
